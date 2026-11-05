import { differenceInCalendarDays, parseISO } from "date-fns"

import type { PlanAction } from "@/lib/db/schema"
import type { DataHealth } from "@/lib/health"
import { combinedLow, simulate, type Plan, type PlanSnapshot } from "@/lib/plan"
import { spareCash } from "@/lib/plan-budget"
import { goalPlan, planGoal, type BuiltPlan, type GoalTone, type PlanGoal } from "@/lib/plan-goal"

/**
 * The plan's headline numbers, worked out in one place: the goal's gap, the low point,
 * spare cash, drift from the bank and where each action item stands. The Plan page, the
 * MCP tools (get_plan, get_briefing, get_status) and Cas's snapshot all take them from
 * here, so they can only differ on judgement, never on numbers. Pure functions.
 */

/** Days ahead an action item counts as due soon. */
export const DUE_SOON_DAYS = 7

export type ActionStatus = "overdue" | "due_soon" | "later" | "no_due_date"

export type Tx = { accountId: number; date: string; amount: number }

/** The goal for the plan as it stands, from the plan you started (see goalPlan). */
export function goalFor({
  started,
  base,
  live,
  balances,
  txs,
  today,
}: {
  started: BuiltPlan | null
  /** the last plan made with the model, on the snapshot it was made on */
  base: BuiltPlan
  /** the plan as it stands now, on today's snapshot */
  live: BuiltPlan
  balances: Map<number, number>
  txs: Tx[]
  today: string
}): PlanGoal {
  return planGoal({
    goal: goalPlan(started, base, today),
    latest: live.plan,
    current: live.snapshot,
    balances,
    txs,
  })
}

export function actionStatus(dueDate: string | null, today: string): ActionStatus {
  if (!dueDate) return "no_due_date"
  const days = differenceInCalendarDays(parseISO(dueDate), parseISO(today))
  return days < 0 ? "overdue" : days <= DUE_SOON_DAYS ? "due_soon" : "later"
}

export type PlanFigures = ReturnType<typeof planFigures>

export function planFigures({
  live,
  goal,
  health,
  actions,
  today,
}: {
  live: { snapshot: PlanSnapshot; plan: Plan }
  goal: PlanGoal | null
  health: DataHealth | null
  /** the open action items */
  actions: PlanAction[]
  today: string
}) {
  const sim = simulate(live.snapshot, live.plan)
  const low = combinedLow(live.snapshot, sim)
  const spare = spareCash(live.snapshot, sim)
  const tone: GoalTone | null = goal?.tone ?? null
  // a projection that runs out of money is off track, whatever the goal says
  const status: GoalTone =
    low && low.balance < 0 ? "off_track" : (tone ?? (sim.overdrafts.length ? "watch" : "on_track"))
  return {
    today,
    status,
    goal: goal && {
      endDate: goal.endDate,
      target: goal.target,
      forecast: goal.forecast,
      gap: goal.gap,
      tone: goal.tone,
    },
    /** the lowest everything but loans gets, combined, with the plan applied */
    lowPoint: low && { date: low.date, amount: low.balance },
    spareCash: spare && { amount: spare.amount, lowestOn: spare.date },
    overdrafts: sim.overdrafts,
    drift: health?.drift ?? [],
    staleAccounts: health?.staleAccounts ?? [],
    actions: actions
      .filter((a) => a.doneAt === null)
      .map((a) => ({
        actionId: a.id,
        title: a.title,
        dueDate: a.dueDate,
        status: actionStatus(a.dueDate, today),
      })),
  }
}
