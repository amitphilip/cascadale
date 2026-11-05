import { z } from "zod"

import { CHANGES_DATA, isoDate, tool, type CasTool } from "@/lib/cas/tool"
import type { DataHealth } from "@/lib/health"
import type { CategorySpend } from "@/lib/plan-budget"
import { ADJUSTMENT_KINDS, ADJUSTMENT_TARGETS, FREQUENCIES, simulate } from "@/lib/plan"
import { endPosition } from "@/lib/plan-goal"
import { todayLocal } from "@/supabase/functions/_shared/akahu"
import {
  addAdjustment,
  addPlanAction,
  loadFigures,
  removePlanAction,
  setPlanActionDone,
  type FigureSource,
  checkPurchase,
  getPlanState,
  livePlan,
  removeAdjustment,
  removePot,
  tryPlanChange,
  uncoveredBills,
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
  /** balances and transactions for the plan's headline figures */
  figures?: Omit<FigureSource, "health">
}

/** The figures (lib/plan-figures.ts) as the tools report them, or null without a plan. */
export async function toolFigures(ctx: PlanToolContext) {
  if (!ctx.figures) return null
  return loadFigures(await ctx.deps(), { ...ctx.figures, health: ctx.health }, todayLocal())
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
const optionalOperationId = operationId.optional().describe(
  "Any unique string for this change. Retrying with the same id changes nothing twice; one is made up if you leave it out."
)

/** What every write to the plan does and returns. */
const WRITE_NOTE =
  "Takes effect at once: the Plan page and get_plan have it straight away. Returns exactly what changed and what the plan now does (planNow: monthly totals, overdrafts, bills no pot covers, where it ends)."

const potInput = {
  name: z.string().trim().min(1).max(60),
  amount: z.number().positive().describe("Set aside each time, in the household's currency"),
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
        "The savings plan the Plan page shows, as it stands today: what to set aside into which pot and when, its focus and warnings, its simulation's monthly totals, overdrafts and bills no pot covers, where it ends, your pots and one-off adjustments, recent changes with who made them, and Cas decisions still to carry out (unappliedDecisions). status is current or no_plan. figures has the headline numbers every view shares: status, the goal's gap, the low point, spare cash, drift and each open action item's status. Includes data_health.",
      run: async () => {
        const [deps, health, figures] = await Promise.all([ctx.deps(), ctx.health(), toolFigures(ctx)])
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
          ...rest,
          figures,
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
        "Check a purchase against the plan without saving anything: runs it as a one-off on its date and returns verdict (yes; over_budget: the cash is there but it breaks the category's month; wait: not now, but it fits from earliestDate, the first payday it does; no: it doesn't fit anywhere in the projection), spare cash before and after (the lowest your accounts get with every bill and set-aside paid, savings pots left alone; below zero means something goes unpaid), the category's limit, spend and what's left this month, the plan's monthly left over, and where the plan ends before and after. Use it for every 'can I buy / afford' question, then weigh it against the goal's gap.",
      input: {
        name: z.string().trim().min(1).max(120).describe("What it is, e.g. New phone"),
        amount: z.number().positive(),
        date: isoDate.optional().describe("When they'd buy it; defaults to today"),
        accountId: accountId.optional().describe("The account it'd be paid from; defaults to the cash account with the most in it"),
        category: z.string().trim().optional().describe("The expense category it counts against, by name"),
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
      name: "upsert_pot",
      title: "Add or change a pot",
      access: "action",
      description: `${CHANGES_DATA} Add a pot or set-aside to the plan, or change the one with this name: e.g. Sharesies, 650 monthly, from Mary's pay into the Sharesies account. It replaces any pot of that name the planner made, and the bills it covers leave other pots. ${WRITE_NOTE}`,
      input: { operationId, reason, decisionIds, ...potInput },
      run: async (args) => upsertPot(await ctx.deps(), args),
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

    tool({
      name: "list_plan_actions",
      title: "Plan action items",
      access: "read",
      description:
        "The action items on the Plan page: things to do about the plan, each with an actionId, title, optional detail and dueDate, whether it's done (doneAt) and who added it. Check it before suggesting an action, so you don't repeat one that's already there. get_briefing already lists the open ones.",
      input: { includeDone: z.boolean().optional().describe("Include finished items. Defaults to open ones only.") },
      run: async ({ includeDone }) => ({
        actions: await (await ctx.deps()).repo.listActions(!!includeDone),
        today: todayLocal(),
      }),
    }),

    tool({
      name: "add_plan_action",
      title: "Add a plan action item",
      access: "action",
      description:
        `${CHANGES_DATA} Put an action item on the Plan page, e.g. 'Move $500 to the tax pot before 20 Nov'. Keep the title short and concrete, and put the numbers in the detail. Adding a title that's already open returns the existing item instead of a duplicate. For one that moves money, give the amount and accounts: the next bank sync ticks it off itself when a matching transfer shows up.`,
      input: {
        operationId: optionalOperationId,
        reason,
        title: z.string().trim().min(1).max(120),
        detail: z.string().trim().optional().describe("One sentence of why or how, with the key number"),
        dueDate: isoDate.optional(),
        amount: z.number().positive().optional().describe("For an item that moves money: how much"),
        fromAccountId: accountId.optional().describe("The account the money leaves"),
        toAccountId: accountId.optional().describe("The account it goes to"),
      },
      run: async (args) => ({ ok: true, ...(await addPlanAction(await ctx.deps(), args)) }),
    }),

    tool({
      name: "set_plan_action_done",
      title: "Mark a plan action item done or not done",
      access: "action",
      description:
        `${CHANGES_DATA} Tick off a plan action item by its actionId from list_plan_actions, or reopen it with done false.`,
      input: { operationId: optionalOperationId, reason, actionId: z.number().int().positive(), done: z.boolean() },
      run: async (args) => ({ ok: true, ...(await setPlanActionDone(await ctx.deps(), args)) }),
    }),

    tool({
      name: "remove_plan_action",
      title: "Remove a plan action item",
      access: "action",
      description: `${CHANGES_DATA} Delete a plan action item by its actionId from list_plan_actions.`,
      input: { operationId: optionalOperationId, reason, actionId: z.number().int().positive() },
      run: async (args) => ({ ok: true, ...(await removePlanAction(await ctx.deps(), args)) }),
    }),
  ]
}
