import { addDays, format, parseISO } from "date-fns"

import { HORIZON_DAYS, simulate, type Plan, type PlanSnapshot } from "@/lib/plan"

/**
 * The plan's end goal and how it's tracking day by day, as a net position: the cash you
 * hold less what you owe on cards, overdrafts and revolving credit, home and other loans
 * left out. Like net worth, an account counts by its sign, so a revolving credit facility
 * typed as a cheque account is owed while it's below zero. Net is what's tracked because
 * paying a card down from cash leaves it unchanged; cash and owed are kept alongside.
 *
 * The goal is what the plan you started said that net position would be by the end of its
 * horizon. Changes to the plan, by you or by Cas, change the path to it but not the target;
 * a new plan sets a new one. Pure functions.
 */

export type GoalDay = {
  date: string
  /** where the plan you started expected the net position to be */
  planned: number
  /** what it was, from your transactions; null after the last day with data */
  actual: number | null
  /** where today's plan takes it from the last day with data on; null before */
  forecast: number | null
}

/** A net position in its two parts: cash held (positive) and owed (negative). */
export type Split = { cash: number; owed: number }

export type GoalTone = "on_track" | "watch" | "off_track"

export type PlanGoal = {
  /** the last day of data the goal's plan was built on */
  startedOn: string
  endDate: string
  target: number
  targetSplit: Split
  /** where today's plan lands on the end date */
  forecast: number
  forecastSplit: Split
  /** forecast less target: below zero means short of the goal */
  gap: number
  /** the last day with data: planned against actual */
  latest: ({ date: string; planned: number; actual: number } & Split) | null
  tone: GoalTone
  days: GoalDay[]
}

export type BuiltPlan = { snapshot: PlanSnapshot; plan: Plan }

/** Short of the goal by up to this share of a month's income is "watch", not off track. */
const WATCH_SHARE = 0.1

const round2 = (n: number) => Math.round(n * 100) / 100
const toIso = (d: Date) => format(d, "yyyy-MM-dd")
const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0))

export function splitOf(balances: number[]): Split {
  return {
    cash: sum(balances.filter((b) => b > 0)),
    owed: sum(balances.filter((b) => b < 0)),
  }
}

/** Account ids that count towards the goal: everything but loans. */
const goalAccounts = (snap: PlanSnapshot) =>
  snap.accounts.filter((a) => a.type !== "loan").map((a) => a.id)

/** Each simulated day's balance for every account in `ids`, in that order. */
function simulated(snap: PlanSnapshot, plan: Plan, ids: number[]) {
  const sim = simulate(snap, plan)
  const start = ids.map((id) => snap.accounts.find((a) => a.id === id)?.balance ?? 0)
  const byDay = new Map(
    sim.days.map((d, i) => [d, ids.map((id, j) => sim.balances[id]?.[i] ?? start[j])])
  )
  return { byDay, start, income: sim.monthly.income }
}

/** Where a plan leaves the net position on the last simulated day. */
export function endPosition(snap: PlanSnapshot, plan: Plan) {
  const { byDay } = simulated(snap, plan, goalAccounts(snap))
  const [date, balances] = [...byDay].at(-1)!
  return { date, net: sum(balances), ...splitOf(balances) }
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
  /** the plan as it stands now */
  latest: Plan
  /** today's snapshot */
  current: PlanSnapshot
  /** each account's balance now, all transactions included */
  balances: Map<number, number>
  txs: { accountId: number; date: string; amount: number }[]
}): PlanGoal {
  const ids = goalAccounts(goal.snapshot)
  const index = new Map(ids.map((id, j) => [id, j]))
  const planned = simulated(goal.snapshot, goal.plan, ids)
  const endDate = [...planned.byDay.keys()].at(-1)!
  const plannedOn = (d: string) =>
    d < goal.snapshot.start ? planned.start : planned.byDay.get(d)!

  const dates: string[] = []
  for (let d = parseISO(goal.snapshot.dataEnd); toIso(d) <= endDate; d = addDays(d, 1))
    dates.push(toIso(d))

  // actual: today's balances, stepped back one day at a time by that day's transactions
  const lastData = current.dataEnd
  const byDate = Map.groupBy(
    txs.filter((t) => index.has(t.accountId)),
    (t) => t.date
  )
  const running = ids.map((id) => balances.get(id) ?? 0)
  const undo = (date: string) => {
    for (const t of byDate.get(date) ?? []) running[index.get(t.accountId)!] -= t.amount
  }
  for (const date of byDate.keys()) if (date > lastData) undo(date)
  const actual = new Map<string, number[]>()
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] > lastData) continue
    actual.set(dates[i], running.map(round2))
    undo(dates[i])
  }

  // forecast: today's plan run on today's data, joined to the last actual
  const ahead = simulated(current, latest, ids)
  const lastActual = actual.get(lastData) ?? null
  const forecastOn = (d: string) =>
    d < lastData ? null : (ahead.byDay.get(d) ?? (d < current.start ? lastActual : null))

  const days = dates.map((date) => {
    const a = actual.get(date)
    const f = forecastOn(date)
    return {
      date,
      planned: sum(plannedOn(date)),
      actual: a ? sum(a) : null,
      forecast: f ? sum(f) : null,
    }
  })

  const targetBalances = plannedOn(endDate)
  const forecastBalances =
    (endDate <= lastData ? actual.get(endDate) : forecastOn(endDate)) ?? targetBalances
  const target = sum(targetBalances)
  const forecast = sum(forecastBalances)
  const gap = round2(forecast - target)
  const last = days.findLast((d) => d.actual !== null)
  return {
    startedOn: goal.snapshot.dataEnd,
    endDate,
    target,
    targetSplit: splitOf(targetBalances),
    forecast,
    forecastSplit: splitOf(forecastBalances),
    gap,
    latest: last
      ? {
          date: last.date,
          planned: last.planned,
          actual: last.actual!,
          ...splitOf(actual.get(last.date)!),
        }
      : null,
    tone: gap >= 0 ? "on_track" : -gap <= ahead.income * WATCH_SHARE ? "watch" : "off_track",
    days,
  }
}
