import { addDays, format, parseISO } from "date-fns"

import {
  HORIZON_DAYS,
  isDebtAccount,
  simulate,
  type Plan,
  type PlanSnapshot,
} from "@/lib/plan"

/**
 * The plan's end goal and how it's tracking day by day, as a net position: the cash you
 * hold less what you owe on cards and overdrafts. Debt that's paid down over months, loans
 * and revolving credit (flexi) accounts, is a liability and is left out of it, so the day
 * by day shows the money you actually run on; revolving credit is tracked beside it as
 * what's still owed. Net is what's tracked because paying a card down from cash leaves it
 * unchanged; cash and owed are kept alongside.
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
  /**
   * actual against the plan, revolving credit included, so money moved from cash to pay
   * it down isn't counted as falling behind; null after the last day with data
   */
  offPlan: number | null
}

/** A net position in its two parts: cash held (positive) and owed (negative). */
export type Split = { cash: number; owed: number }

/** What's owed on revolving credit, as a positive amount, tracked apart from the goal. */
export type GoalDebt = {
  accounts: string[]
  /** owed when the goal was set */
  startedAt: number
  /** owed on the last day with data */
  now: number
  /** what the plan you started said would still be owed on the end date */
  target: number
  /** what today's plan leaves owed on the end date */
  forecast: number
}

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
  /**
   * forecast less target, plus any revolving credit paid down beyond the plan's (so a
   * bigger repayment from cash isn't a shortfall): below zero means short of the goal
   */
  gap: number
  /** the last day with data: planned against actual */
  latest:
    | ({ date: string; planned: number; actual: number; offPlan: number } & Split)
    | null
  tone: GoalTone
  days: GoalDay[]
  /** revolving credit, left out of the figures above; null without any */
  debt: GoalDebt | null
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

/**
 * Account ids that count towards the goal: everything but loans and revolving credit.
 * Types come from `types` when given (today's, so retyping an account applies to a goal
 * set before it), else from the snapshot.
 */
const goalAccounts = (snap: PlanSnapshot, types?: Map<number, string>) =>
  snap.accounts
    .filter((a) => !isDebtAccount(types?.get(a.id) ?? a.type))
    .map((a) => a.id)

/** Revolving credit account ids, tracked as debt beside the goal. */
const creditLines = (snap: PlanSnapshot, types?: Map<number, string>) =>
  snap.accounts
    .filter((a) => (types?.get(a.id) ?? a.type) === "credit_line")
    .map((a) => a.id)

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
  const cashIds = goalAccounts(snap)
  const debtIds = creditLines(snap)
  const { byDay } = simulated(snap, plan, [...cashIds, ...debtIds])
  const [date, all] = [...byDay].at(-1)!
  const balances = all.slice(0, cashIds.length)
  return {
    date,
    net: sum(balances),
    ...splitOf(balances),
    /** still owed on revolving credit, left out of net */
    revolvingOwed: -sum(all.slice(cashIds.length)),
  }
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
  const types = new Map(current.accounts.map((a) => [a.id, a.type]))
  const cashIds = goalAccounts(goal.snapshot, types)
  const debtIds = creditLines(goal.snapshot, types).filter((id) => types.has(id))
  // both are simulated together; `cashOf` and `debtOf` pick each out of a day's balances
  const ids = [...cashIds, ...debtIds]
  const cashOf = (b: number[]) => b.slice(0, cashIds.length)
  const debtOf = (b: number[]) => -sum(b.slice(cashIds.length))
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
    const p = plannedOn(date)
    return {
      date,
      planned: sum(cashOf(p)),
      actual: a ? sum(cashOf(a)) : null,
      forecast: f ? sum(cashOf(f)) : null,
      offPlan: a ? round2(sum(a) - sum(p)) : null,
    }
  })

  const targetAll = plannedOn(endDate)
  const forecastAll =
    (endDate <= lastData ? actual.get(endDate) : forecastOn(endDate)) ?? targetAll
  const targetBalances = cashOf(targetAll)
  const forecastBalances = cashOf(forecastAll)
  const target = sum(targetBalances)
  const forecast = sum(forecastBalances)
  const gap = round2(sum(forecastAll) - sum(targetAll))
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
          offPlan: last.offPlan!,
          ...splitOf(cashOf(actual.get(last.date)!)),
        }
      : null,
    tone: gap >= 0 ? "on_track" : -gap <= ahead.income * WATCH_SHARE ? "watch" : "off_track",
    days,
    debt:
      debtIds.length === 0
        ? null
        : {
            accounts: debtIds.map(
              (id) => current.accounts.find((a) => a.id === id)?.name ?? `Account ${id}`
            ),
            startedAt: debtOf(plannedOn(dates[0])),
            now: -sum(debtIds.map((id) => balances.get(id) ?? 0)),
            target: debtOf(targetAll),
            forecast: debtOf(forecastAll),
          },
  }
}
