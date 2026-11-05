import { getDaysInMonth, parseISO } from "date-fns"

import type { PlanSnapshot, Simulation } from "@/lib/plan"

// This month's spending against the plan, category by category, and how much cash is
// genuinely spare. Shared by the Plan page and Cas's check_purchase, so both say the same.

/** One expense category's monthly cost in the plan's snapshot. */
export type CategoryCost = {
  category: string
  /** scheduled bills, per month */
  bills: number
  /** day-to-day spending, per month */
  dayToDay: number
  budget: number | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Monthly spending per expense category, biggest first; with `accounts`, only what's paid
 * from them, and no budgets (those are the household's).
 */
export function categoryCosts(snap: PlanSnapshot, accounts?: Set<number>): CategoryCost[] {
  const costs = new Map<string, CategoryCost>()
  const get = (category: string) => {
    const c = costs.get(category) ?? {
      category,
      bills: 0,
      dayToDay: 0,
      budget: accounts
        ? null
        : (snap.budgets.find((b) => b.category === category)?.budget ?? null),
    }
    costs.set(category, c)
    return c
  }
  const counts = (accountId: number) => !accounts || accounts.has(accountId)
  for (const b of snap.bills) if (counts(b.accountId)) get(b.category).bills += b.monthly
  for (const v of snap.variable) if (counts(v.accountId)) get(v.category).dayToDay += v.monthly
  return [...costs.values()]
    .map((c) => ({ ...c, bills: round2(c.bills), dayToDay: round2(c.dayToDay) }))
    .filter((c) => c.bills + c.dayToDay >= 1)
    .sort((a, b) => b.bills + b.dayToDay - (a.bills + a.dayToDay))
}

/** A category's net spend this month (refunds reduce it); a null id is uncategorized. */
export type CategorySpend = { id: number | null; name: string; spent: number }

export type BudgetStatus = "over" | "ahead" | "ok" | "unplanned"

export type BudgetLine = {
  category: string
  spent: number
  /** the month's limit: its budget if it has one, else what the plan expects it to cost */
  limit: number
  fromBudget: boolean
  /** what the plan expects it to cost a month */
  planned: number
  /** what an even pace would have spent by today */
  expected: number
  /** limit less spent; negative when over */
  left: number
  /**
   * over: past its limit. ahead: day-to-day spending running well ahead of the month's
   * pace. unplanned: spending the plan doesn't expect at all.
   */
  status: BudgetStatus
}

export type MonthBudget = {
  /** yyyy-MM */
  month: string
  daysInMonth: number
  /** days left in the month, today included */
  daysLeft: number
  /** share of the month gone, today included */
  pace: number
  lines: BudgetLine[]
  spent: number
  limit: number
  left: number
  uncategorized: number
  /** at least one category has a budget set */
  anyBudgets: boolean
}

/** Spending well past an even pace before it counts as ahead: a share and a floor. */
const AHEAD_BY = 1.2
const AHEAD_MIN = 20

/** This month's spending per category against its budget, or the plan's amount when it has none. */
export function monthBudget(
  costs: CategoryCost[],
  spend: CategorySpend[],
  today: string
): MonthBudget {
  const day = parseISO(today)
  const daysInMonth = getDaysInMonth(day)
  const dayOfMonth = day.getDate()
  const pace = dayOfMonth / daysInMonth
  const spentOf = new Map(
    spend.filter((s) => s.id !== null).map((s) => [s.name, Math.max(0, s.spent)])
  )

  const planned = costs.map((c): BudgetLine => {
    const spent = round2(spentOf.get(c.category) ?? 0)
    const plannedMonthly = round2(c.bills + c.dayToDay)
    const limit = c.budget ?? plannedMonthly
    // bills land on their own dates, so only day-to-day spending has a pace to keep
    const expected = round2(c.bills + c.dayToDay * pace)
    const dayToDayLed = c.dayToDay >= c.bills
    const status: BudgetStatus =
      spent > limit + 0.5
        ? "over"
        : dayToDayLed && spent > expected * AHEAD_BY + AHEAD_MIN
          ? "ahead"
          : "ok"
    return {
      category: c.category,
      spent,
      limit,
      fromBudget: c.budget !== null,
      planned: plannedMonthly,
      expected: Math.min(expected, limit),
      left: round2(limit - spent),
      status,
    }
  })
  const known = new Set(costs.map((c) => c.category))
  const unplanned = spend
    .filter((s) => s.id !== null && !known.has(s.name) && s.spent >= 1)
    .map(
      (s): BudgetLine => ({
        category: s.name,
        spent: round2(s.spent),
        limit: 0,
        fromBudget: false,
        planned: 0,
        expected: 0,
        left: round2(-s.spent),
        status: "unplanned",
      })
    )

  const lines = [...planned, ...unplanned]
  const spent = round2(lines.reduce((s, l) => s + l.spent, 0))
  const limit = round2(lines.reduce((s, l) => s + l.limit, 0))
  return {
    month: today.slice(0, 7),
    daysInMonth,
    daysLeft: daysInMonth - dayOfMonth + 1,
    pace,
    lines,
    spent,
    limit,
    left: round2(limit - spent),
    uncategorized: round2(
      Math.max(0, spend.find((s) => s.id === null)?.spent ?? 0)
    ),
    anyBudgets: costs.some((c) => c.budget !== null),
  }
}

/**
 * What you could spend today and still pay every bill and set-aside over the projection:
 * the lowest point of everything you hold except loans, less what sits in savings pots
 * (money that's been put away isn't spare). What you already owe on cards and revolving
 * credit is set aside, since paying it down is the goal's job; new spending on them
 * still counts. Null without accounts.
 */
export function spareCash(snap: PlanSnapshot, sim: Simulation) {
  const held = snap.accounts.filter((a) => a.type !== "loan")
  if (held.length === 0 || sim.days.length === 0) return null
  const owed = held.reduce((s, a) => s + Math.min(0, a.balance), 0)
  const savings = sim.potSummaries.filter((p) => p.covers.length === 0)
  let low = { date: sim.days[0], balance: Infinity }
  sim.days.forEach((date, i) => {
    const total = held.reduce((s, a) => s + (sim.balances[a.id]?.[i] ?? a.balance), 0)
    const saved = savings.reduce((s, p) => s + (sim.pots[p.name]?.[i] ?? 0), 0)
    const free = total - owed - saved
    if (free < low.balance) low = { date, balance: free }
  })
  const balance = round2(low.balance)
  return { date: low.date, balance, amount: Math.max(0, balance) }
}
