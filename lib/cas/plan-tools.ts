import { z } from "zod"

import { CHANGES_DATA, isoDate, tool, type CasTool } from "@/lib/cas/tool"
import type { DataHealth } from "@/lib/health"
import { ADJUSTMENT_KINDS, ADJUSTMENT_TARGETS, FREQUENCIES, simulate } from "@/lib/plan"
import {
  addAdjustment,
  getPlanState,
  regeneratePlan,
  removeAdjustment,
  removePot,
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

/** Plan instructions that changed but aren't in the built plan yet, in one line. */
const WRITE_NOTE =
  "Records the change and marks the plan out of date; it shows on the Plan page at once, and is applied to the plan by regenerate_plan (or Rebuild on the website). Returns exactly what changed."

/** Status reasons that come from the data rather than the plan's instructions. */
export function healthReasons(health: DataHealth) {
  return health.plan?.movedMaterially
    ? [
        `balances moved since the plan was built (${health.plan.basis
          .filter((b) => b.material)
          .map((b) => b.name)
          .join(", ")})`,
      ]
    : []
}

export function planTools(ctx: PlanToolContext): CasTool[] {
  return [
    tool({
      name: "get_plan",
      title: "Current plan",
      access: "read",
      description:
        "The savings plan the Plan page shows: what to set aside into which pot and when, its focus and warnings, the monthly totals of its simulation, your pots and one-off adjustments, and recent changes with who made them. status is current, out_of_date (with reasons: changes or Cas decisions not applied yet, or balances that moved since it was built; offer regenerate_plan) or no_plan. planId goes to regenerate_plan's expectedPlanId. Includes data_health.",
      run: async () => {
        const [deps, health] = await Promise.all([ctx.deps(), ctx.health()])
        const state = await getPlanState(deps, healthReasons(health))
        const { plan, ...rest } = state
        return {
          planId: plan?.id ?? null,
          madeAt: plan?.createdAt ?? null,
          madeBy: plan?.madeBy ?? null,
          dataEnd: plan?.snapshot.dataEnd ?? null,
          plan: plan?.plan ?? null,
          monthly: plan ? simulate(plan.snapshot, plan.plan).monthly : null,
          adjustmentsInPlan: plan?.snapshot.adjustments ?? [],
          ...rest,
          data_health: health,
        }
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
      name: "regenerate_plan",
      title: "Rebuild the plan",
      access: "action",
      description: `${CHANGES_DATA} Rebuild the plan the Plan page shows from today's data, with every pot and one-off adjustment applied and the current plan's other set-asides kept. Quick and deterministic (doesn't ask a model). Returns the new plan, its monthly totals, the changes it applied, and a diff against the previous plan (pots, incomes and bills added or removed, monthly totals before and after). Pass expectedPlanId from get_plan to fail rather than rebuild over a plan someone else changed in the meantime.`,
      input: {
        operationId,
        reason,
        decisionIds,
        expectedPlanId: z.number().int().positive().optional().describe("The planId you read; the rebuild fails if the plan changed since"),
      },
      run: async (args) => regeneratePlan(await ctx.deps(), args),
    }),

    tool({
      name: "upsert_pot",
      title: "Add or change a pot",
      access: "action",
      description: `${CHANGES_DATA} Add a pot or set-aside to the plan, or change the one with this name: e.g. Sharesies, 650 monthly, from Mary's pay into the Sharesies account. It replaces any pot of that name the planner made, and the bills it covers leave other pots. ${WRITE_NOTE}`,
      input: {
        operationId,
        reason,
        decisionIds,
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
      },
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
      input: {
        operationId,
        reason,
        decisionIds,
        date: isoDate,
        kind: z.enum(ADJUSTMENT_KINDS),
        target: z.enum(ADJUSTMENT_TARGETS).describe("bill, pot (a pot's set-aside) or transfer (between two of your accounts)"),
        name: z.string().trim().max(120).optional().describe("The bill (key or name) or pot (name); for a transfer, an optional label"),
        amount: z.number().positive().optional().describe("For add and change_amount"),
        fromAccountId: accountId.optional().describe("For a transfer: the account it leaves"),
        toAccountId: accountId.optional().describe("For a transfer: the account it goes to"),
      },
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
