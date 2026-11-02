import { addDays, format, parseISO } from "date-fns"

import { HORIZON_DAYS, simulate, type Plan, type PlanSnapshot } from "@/lib/plan"

/**
 * The plan's end goal and how it's tracking day by day. The goal is what the plan you
 * started said you'd hold in everything but loans by the end of its horizon. Rebuilds, by
 * you or by Cas, change the path to it but not the target; a new plan sets a new one.
 * Transfers between your own accounts cancel out in the combined figure, so it can be
 * compared with what actually happened. Pure functions.
 */

export type GoalDay = {
  date: string
  /** where the plan you started expected the combined balance to be */
  planned: number
  /** what it was, from your transactions; null after the last day with data */
  actual: number | null
  /** where today's plan takes it from the last day with data on; null before */
  forecast: number | null
}

export type GoalTone = "on_track" | "watch" | "off_track"

export type PlanGoal = {
  /** the last day of data the goal's plan was built on */
  startedOn: string
  endDate: string
  target: number
  /** where today's plan lands on the end date */
  forecast: number
  /** forecast less target: below zero means short of the goal */
  gap: number
  /** the last day with data: planned against actual */
  latest: { date: string; planned: number; actual: number } | null
  tone: GoalTone
  days: GoalDay[]
}

export type BuiltPlan = { snapshot: PlanSnapshot; plan: Plan }

/** Short of the goal by up to this share of a month's income is "watch", not off track. */
const WATCH_SHARE = 0.1

const round2 = (n: number) => Math.round(n * 100) / 100
const toIso = (d: Date) => format(d, "yyyy-MM-dd")

/** Account ids that count towards the goal: everything but loans. */
const goalAccounts = (snap: PlanSnapshot) =>
  snap.accounts.filter((a) => a.type !== "loan").map((a) => a.id)

/** The combined balance each simulated day. */
function combined(snap: PlanSnapshot, plan: Plan, ids: number[]) {
  const sim = simulate(snap, plan)
  const byDay = new Map(
    sim.days.map((d, i) => [
      d,
      round2(ids.reduce((s, id) => s + (sim.balances[id]?.[i] ?? 0), 0)),
    ])
  )
  return { byDay, income: sim.monthly.income }
}

/** The plan that sets the goal: the one you started, unless its horizon has passed. */
export function goalPlan(
  started: BuiltPlan | null,
  latest: BuiltPlan,
  today: string
): BuiltPlan {
  if (!started) return latest
  const end = toIso(addDays(parseISO(started.snapshot.start), HORIZON_DAYS - 1))
  return end >= today ? started : latest
}

export function planGoal({
  goal,
  latest,
  current,
  balances,
  txs,
}: {
  /** the plan that sets the target (see goalPlan) */
  goal: BuiltPlan
  /** the plan as it is now, after any rebuilds */
  latest: Plan
  /** today's snapshot */
  current: PlanSnapshot
  /** each account's balance now, all transactions included */
  balances: Map<number, number>
  txs: { accountId: number; date: string; amount: number }[]
}): PlanGoal {
  const ids = goalAccounts(goal.snapshot)
  const counted = new Set(ids)
  const planned = combined(goal.snapshot, goal.plan, ids).byDay
  const simDays = [...planned.keys()]
  const endDate = simDays.at(-1)!
  const startBalance = round2(
    goal.snapshot.accounts
      .filter((a) => counted.has(a.id))
      .reduce((s, a) => s + a.balance, 0)
  )
  const target = planned.get(endDate) ?? startBalance

  // actual: today's balances, stepped back one day at a time by that day's transactions
  const byDate = new Map<string, number>()
  for (const t of txs)
    if (counted.has(t.accountId))
      byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.amount)
  const dates: string[] = []
  for (
    let d = parseISO(goal.snapshot.dataEnd);
    toIso(d) <= endDate;
    d = addDays(d, 1)
  )
    dates.push(toIso(d))
  const lastData = current.dataEnd
  const actual = new Map<string, number>()
  let running = ids.reduce((s, id) => s + (balances.get(id) ?? 0), 0)
  for (const t of txs)
    if (counted.has(t.accountId) && t.date > lastData) running -= t.amount
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i]
    if (d > lastData) continue
    actual.set(d, round2(running))
    running -= byDate.get(d) ?? 0
  }

  // forecast: today's plan run on today's data, joined to the last actual
  const { byDay: ahead, income } = combined(current, latest, ids)
  const lastActual = actual.get(lastData) ?? null
  const forecastOn = (d: string) =>
    d < lastData
      ? null
      : (ahead.get(d) ?? (d < current.start ? lastActual : null))

  const days = dates.map((date) => ({
    date,
    planned: date < goal.snapshot.start ? startBalance : planned.get(date)!,
    actual: actual.get(date) ?? null,
    forecast: forecastOn(date),
  }))

  const forecast =
    endDate <= lastData
      ? (actual.get(endDate) ?? target)
      : (forecastOn(endDate) ?? target)
  const gap = round2(forecast - target)
  const last = days.findLast((d) => d.actual !== null)
  return {
    startedOn: goal.snapshot.dataEnd,
    endDate,
    target,
    forecast,
    gap,
    latest: last
      ? { date: last.date, planned: last.planned, actual: last.actual! }
      : null,
    tone:
      gap >= 0
        ? "on_track"
        : -gap <= income * WATCH_SHARE
          ? "watch"
          : "off_track",
    days,
  }
}
