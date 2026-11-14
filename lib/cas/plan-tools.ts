import { z } from "zod"

import { CHANGES_DATA, isoDate, tool, type CasTool } from "@/lib/cas/tool"
import type { DataHealth } from "@/lib/health"
import type { CategorySpend } from "@/lib/plan-budget"
import { ADJUSTMENT_KINDS, ADJUSTMENT_TARGETS, FREQUENCIES, simulate } from "@/lib/plan"
import { endPosition } from "@/lib/plan-goal"
import { POT_TYPES, RESET_MODES, potHealth } from "@/lib/pots"
import { todayLocal } from "@/supabase/functions/_shared/akahu"
import {
  addAdjustment,
  addPotEntry,
  checkPurchase,
  getPlanState,
  linkTransactionToPot,
  livePlan,
  potLedgerFor,
  potLedgers,
  removeAdjustment,
  removePot,
  removePotEntry,
  tryPlanChange,
  uncoveredBills,
  unlinkTransactionFromPot,
  upsertPot,
  type PlanDeps,
} from "@/lib/plan-service"

// The plan's MCP tools: read it, and change the plan the Plan page shows. They're thin
// wrappers over lib/plan-service.ts, the same service the Plan page and its actions use,
// so a change here is what the website shows. Defined over injected dependencies so the
// tests can run them against fixture data.

export type PlanToolContext = {
  /** the plan service acting as Claude (MCP) */
  deps: () => Promise<PlanDeps>
  health: () => Promise<DataHealth>
  /** this month's spend per category, for check_purchase's budget line */
  categorySpend?: (month: string) => Promise<CategorySpend[]>
}

const operationId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "Any unique string for this change, e.g. a UUID. Retrying with the same id returns the first result and changes nothing twice."
  )
const reason = z.string().trim().max(500).optional().describe("Why, in a few words; shown on the Plan page")
const decisionIds = z
  .array(z.number().int().positive())
  .optional()
  .describe("Cas decision notes (from get_plan's unappliedDecisions) this change carries out")
const accountId = z.number().int().positive()

/** What every write to the plan does and returns. */
const WRITE_NOTE =
  "Takes effect at once: the Plan page and get_plan have it straight away. Returns exactly what changed and what the plan now does (planNow: monthly totals, overdrafts, bills no pot covers, where it ends)."

const potInput = {
  name: z.string().trim().min(1).max(60),
  type: z
    .enum(POT_TYPES)
    .optional()
    .describe(
      "set_aside (default for a new pot): money put by for bills or saving. sinking_fund: also drawn from: lumpy, known costs (air tickets, invoices) are paid out of it, with a ledger, running balance, optional cap and end date or yearly reset. Omit to keep an existing pot's type."
    ),
  amount: z
    .number()
    .nonnegative()
    .describe("Set aside each time, in the household's currency. A sinking fund can take 0 until you pick an amount; its ledger suggests one."),
  frequency: z
    .enum(FREQUENCIES)
    .describe("payday: every time the income lands; fortnightly; monthly: once a month (on its payday if the income is monthly, else the 1st)"),
  income: z
    .string()
    .optional()
    .describe("Which income funds it: an income key from get_financial_picture or part of its name. Its account is the default from account."),
  fromAccountId: accountId.optional().describe("Account the money comes from; defaults to the income's account"),
  toAccountId: accountId.optional().describe("Account it moves to; omit to earmark it in the from account"),
  covers: z.array(z.string()).optional().describe("Bills it pays: their keys or names"),
  note: z.string().trim().max(200).optional(),
  cap: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe("Sinking funds: the most it pays out per cycle, e.g. 7500. null removes it; omit to keep it."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use yyyy-MM-dd or yyyy-MM")
    .nullable()
    .optional()
    .describe("Sinking funds: its last day, yyyy-MM-dd, or yyyy-MM for that month's last day (e.g. 2027-04). null for open-ended; omit to keep it."),
  resetDate: isoDate
    .nullable()
    .optional()
    .describe("Sinking funds: start the cap and totals again every year on this date's day and month. null for none; omit to keep it."),
  resetMode: z
    .enum(RESET_MODES)
    .optional()
    .describe("Sinking funds: at a reset, carry the leftover balance over (default) or release it"),
  startDate: isoDate
    .optional()
    .describe("Sinking funds: count its scheduled contributions from this date. Defaults to today for a new fund."),
}

const adjustmentInput = {
  date: isoDate,
  kind: z.enum(ADJUSTMENT_KINDS),
  target: z.enum(ADJUSTMENT_TARGETS).describe("bill, pot (a pot's set-aside) or transfer (between two of your accounts)"),
  name: z.string().trim().max(120).optional().describe("The bill (key or name) or pot (name); for a transfer, an optional label"),
  amount: z.number().positive().optional().describe("For add and change_amount"),
  fromAccountId: accountId.optional().describe("For a transfer: the account it leaves"),
  toAccountId: accountId.optional().describe("For a transfer: the account it goes to"),
}

export function planTools(ctx: PlanToolContext): CasTool[] {
  return [
    tool({
      name: "get_plan",
      title: "Current plan",
      access: "read",
      description:
        "The savings plan the Plan page shows, as it stands today: what to set aside into which pot and when, its focus and warnings, its simulation's monthly totals, overdrafts and bills no pot covers, where it ends, your pots and one-off adjustments, recent changes with who made them, and Cas decisions still to carry out (unappliedDecisions). status is current or no_plan. Includes data_health.",
      run: async () => {
        const [deps, health] = await Promise.all([ctx.deps(), ctx.health()])
        const [{ plan: base, ...rest }, live] = await Promise.all([getPlanState(deps), livePlan(deps)])
        const sim = live && simulate(live.snapshot, live.plan)
        return {
          madeAt: base?.createdAt ?? null,
          dataEnd: live?.snapshot.dataEnd ?? null,
          plan: live?.plan ?? null,
          monthly: sim?.monthly ?? null,
          overdrafts: sim?.overdrafts ?? null,
          uncoveredBills: live && uncoveredBills(live.snapshot, live.plan),
          end: live ? endPosition(live.snapshot, live.plan) : null,
          sinkingFunds: live?.ledgers.map(potHealth) ?? [],
          ...rest,
          data_health: health,
        }
      },
    }),

    tool({
      name: "try_plan_change",
      title: "Try a plan change",
      access: "read",
      description:
        "Run a change through the real simulation without saving it: pots to add or change, pots to remove, one-off adjustments, or a bill costing a different amount. Combine several to compare a whole idea. Returns the diff against the plan as it stands (pots, monthly totals, overdrafts, bills no pot covers), where the plan ends before and after, and any overdrafts and warnings. Use it to answer what-ifs, and before recommending or making a change.",
      input: {
        pots: z.array(z.object(potInput)).optional(),
        removePots: z.array(z.string().trim().min(1)).optional(),
        adjustments: z.array(z.object(adjustmentInput)).optional(),
        bills: z
          .array(z.object({ name: z.string().trim().min(1), amount: z.number().nonnegative().describe("Per occurrence") }))
          .optional()
          .describe("Bills costing something else, by key or name"),
      },
      run: async (args) => tryPlanChange(await ctx.deps(), args),
    }),

    tool({
      name: "check_purchase",
      title: "Can I buy this?",
      access: "read",
      description:
        "Check a purchase against the plan without saving anything: runs it as a one-off on its date (from a sinking fund when pot is given) and returns verdict (yes; over_budget: the cash is there but it breaks the category's month; over_pot: the cash is there but the fund is over its cap or short; wait: not now, but it fits from earliestDate, the first payday it does; no: it doesn't fit anywhere in the projection), spare cash before and after (the lowest your accounts get with every bill and set-aside paid, savings pots left alone; below zero means something goes unpaid), the category's limit, spend and what's left this month, the fund's balance and cap before and after (pot), the plan's monthly left over, and where the plan ends before and after. Use it for every 'can I buy / afford' question, then weigh it against the goal's gap.",
      input: {
        name: z.string().trim().min(1).max(120).describe("What it is, e.g. New phone"),
        amount: z.number().positive(),
        date: isoDate.optional().describe("When they'd buy it; defaults to today"),
        accountId: accountId.optional().describe("The account it'd be paid from; defaults to the cash account with the most in it"),
        category: z.string().trim().optional().describe("The expense category it counts against, by name"),
        pot: z
          .string()
          .trim()
          .optional()
          .describe("A sinking fund to pay it from: tests it against the fund's balance and cap instead of the category (verdict over_pot when the cash is there but the fund can't take it)"),
      },
      run: async (args) => {
        const today = todayLocal()
        const spend = args.category && ctx.categorySpend ? await ctx.categorySpend(today.slice(0, 7)) : null
        return checkPurchase(await ctx.deps(), args, spend, today)
      },
    }),

    tool({
      name: "list_plan_adjustments",
      title: "Plan adjustments",
      access: "read",
      description:
        "One-off adjustments to the plan still in effect (skips, extra payments or transfers, changed amounts on a date), soonest first, with who added each and why, plus your pots. Use an adjustment's id to remove it.",
      run: async () => {
        const deps = await ctx.deps()
        const [adjustments, pots] = await Promise.all([deps.repo.listAdjustments(), deps.repo.listPots()])
        return { adjustments, pots: pots.filter((p) => !p.removed) }
      },
    }),

    tool({
      name: "get_pot_ledger",
      title: "Sinking fund ledger",
      access: "read",
      description:
        "A sinking fund's ledger: every contribution in (scheduled set-asides, top-ups, linked transfers) and draw out (linked transactions), oldest first, with the running balance; this cycle's contributed, spent and balance; the cap, what's used and left (before and after planned draws); planned draws with the balance after each; the next draw and any shortfall; a suggested contribution per period, (cap or planned total less spent less balance) over the periods left; linked transaction totals, which reconcile with the draws; and warnings (over cap, can't cover the next draw). Omit pot for every fund's health in brief.",
      input: { pot: z.string().trim().min(1).optional().describe("The fund's name") },
      run: async ({ pot }) => {
        const deps = await ctx.deps()
        if (pot) return potLedgerFor(deps, pot)
        return { sinkingFunds: (await potLedgers(deps)).ledgers.map(potHealth) }
      },
    }),

    tool({
      name: "upsert_pot",
      title: "Add or change a pot",
      access: "action",
      description: `${CHANGES_DATA} Add a pot or set-aside to the plan, or change the one with this name: e.g. Sharesies, 650 monthly, from Mary's pay into the Sharesies account. It replaces any pot of that name the planner made, and the bills it covers leave other pots. With type sinking_fund it's a fund lumpy costs are paid out of: give it a cap, an endDate or a yearly resetDate, then link transactions and planned draws to it; a fund's result includes its ledger and suggested contribution. Changing a fund's amount or schedule keeps the contributions already made. ${WRITE_NOTE}`,
      input: { operationId, reason, decisionIds, ...potInput },
      run: async (args) => upsertPot(await ctx.deps(), args),
    }),

    tool({
      name: "link_transaction_to_pot",
      title: "Pay a transaction from a sinking fund",
      access: "action",
      description: `${CHANGES_DATA} Link a transaction (its id from search_transactions) to a sinking fund. Money out is a draw: it keeps its category for reporting but no longer counts against that category's budget (category_spending, the Plan page, check-ins) or the plan's day-to-day spending. Money in (e.g. the transfer into the fund's savings account) is a contribution. Pass plannedDrawId to tick off the planned draw it pays. A transaction links to one fund at most. ${WRITE_NOTE}`,
      input: {
        operationId,
        reason,
        pot: z.string().trim().min(1).describe("The fund's name"),
        transactionId: z.number().int().positive(),
        kind: z.enum(["draw", "contribution"]).optional().describe("Defaults to draw for money out, contribution for money in"),
        plannedDrawId: z.number().int().positive().optional().describe("The planned draw (from get_pot_ledger) this pays"),
        note: z.string().trim().max(200).optional(),
      },
      run: async (args) => linkTransactionToPot(await ctx.deps(), args),
    }),

    tool({
      name: "unlink_transaction_from_pot",
      title: "Unlink a transaction from its sinking fund",
      access: "action",
      description: `${CHANGES_DATA} Take a transaction out of its sinking fund: it counts against its category's budget again. ${WRITE_NOTE}`,
      input: { operationId, reason, transactionId: z.number().int().positive() },
      run: async (args) => unlinkTransactionFromPot(await ctx.deps(), args),
    }),

    tool({
      name: "add_pot_planned_draw",
      title: "Plan a draw on a sinking fund",
      access: "action",
      description: `${CHANGES_DATA} Attach an expected one-off to a sinking fund (e.g. Air tickets, 2,400 on 2027-01-15): the simulation pays it from the fund rather than from spending, and the ledger warns if the cap or the balance won't cover it. Link its transaction with plannedDrawId once it's paid. ${WRITE_NOTE}`,
      input: {
        operationId,
        reason,
        pot: z.string().trim().min(1).describe("The fund's name"),
        name: z.string().trim().min(1).max(120),
        amount: z.number().positive(),
        date: isoDate,
      },
      run: async ({ name, ...args }) => addPotEntry(await ctx.deps(), { ...args, name, kind: "planned_draw" }),
    }),

    tool({
      name: "remove_pot_planned_draw",
      title: "Remove a planned draw",
      access: "action",
      description: `${CHANGES_DATA} Remove a planned draw from its sinking fund by its entryId from get_pot_ledger. ${WRITE_NOTE}`,
      input: { operationId, reason, plannedDrawId: z.number().int().positive() },
      run: async ({ plannedDrawId, ...args }) =>
        removePotEntry(await ctx.deps(), { ...args, entryId: plannedDrawId, kind: "planned_draw" }),
    }),

    tool({
      name: "add_pot_contribution",
      title: "Top up a sinking fund",
      access: "action",
      description: `${CHANGES_DATA} Record a manual top-up into a sinking fund on a date, beyond its scheduled set-aside. To count a real transfer instead, link it with link_transaction_to_pot. ${WRITE_NOTE}`,
      input: {
        operationId,
        reason,
        pot: z.string().trim().min(1).describe("The fund's name"),
        amount: z.number().positive(),
        date: isoDate,
        note: z.string().trim().max(120).optional(),
      },
      run: async ({ note, ...args }) =>
        addPotEntry(await ctx.deps(), { ...args, name: note ?? "Top-up", kind: "contribution" }),
    }),

    tool({
      name: "remove_pot",
      title: "Remove a pot",
      access: "action",
      description: `${CHANGES_DATA} Take a pot out of the plan, whether you added it or the planner did. ${WRITE_NOTE}`,
      input: { operationId, reason, decisionIds, name: z.string().trim().min(1) },
      run: async (args) => removePot(await ctx.deps(), args),
    }),

    tool({
      name: "add_plan_adjustment",
      title: "Add a one-off plan adjustment",
      access: "action",
      description: `${CHANGES_DATA} A one-off change to the plan on one date (or the pay nearest it, within 3 days). kind skip: skip a bill or a pot's set-aside that day (e.g. skip the Visa set-aside on 11 Nov). kind change_amount: pay or set aside a different amount that day. kind add: an extra bill payment, an extra set-aside into a pot, or (target transfer) an extra transfer between two accounts (e.g. 943 from Streamline to Joint on 11 Nov). ${WRITE_NOTE}`,
      input: { operationId, reason, decisionIds, ...adjustmentInput },
      run: async (args) => addAdjustment(await ctx.deps(), args),
    }),

    tool({
      name: "remove_plan_adjustment",
      title: "Remove a plan adjustment",
      access: "action",
      description: `${CHANGES_DATA} Cancel a one-off adjustment (its id from list_plan_adjustments); it's kept as history. ${WRITE_NOTE}`,
      input: { operationId, reason, decisionIds, adjustmentId: z.number().int().positive() },
      run: async (args) => removeAdjustment(await ctx.deps(), args),
    }),
  ]
}
