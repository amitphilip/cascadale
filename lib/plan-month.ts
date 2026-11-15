import {
  addDays,
  differenceInCalendarDays,
  endOfMonth,
  getDaysInMonth,
  parseISO,
  startOfWeek,
} from "date-fns"

import type { BudgetPeriod } from "@/lib/db/schema"
import type { PlanSnapshot, Simulation } from "@/lib/plan"
import type { CategoryCost, CategorySpend } from "@/lib/plan-budget"
import type { PotLedger } from "@/lib/pots"

// The front of the Plan page: this month's money in and out (so far, and still to come
// with the plan), every weekly and monthly budget against its spending, and the sinking
// funds' in and out. The full plan behind it is Cas's to keep in step.

const round2 = (n: number) => Math.round(n * 100) / 100
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** Something still to come in or go out this month, from the plan's projection. */
export type MonthItem = {
  date: string
  name: string
  amount: number
  /** the pot that pays a bill, when one does */
  pot: string | null
  /** a one-off: an upcoming expense, an adjustment or a fund's planned draw */
  oneOff: boolean
}

export type MonthInOut = {
  /** yyyy-MM */
  month: string
  /** first day still to come; before it is what's happened */
  from: string
  /** days left in the month from `from`, that day included; 0 once it's past */
  daysLeft: number
  in: {
    /** money in so far this month, transfers left out */
    received: number
    /** regular income still to land this month */
    toCome: number
    expected: number
    items: MonthItem[]
  }
  out: {
    /** money out so far this month, transfers left out */
    spent: number
    /** bills and one-offs still due this month */
    billsToCome: number
    /** day-to-day spending the plan expects for the rest of the month */
    dayToDayToCome: number
    expected: number
    items: MonthItem[]
  }
  /** in less out by the month's end; negative when more goes out than comes in */
  net: number
}

/**
 * This month's money in and out: what's happened (from the transactions), plus what the
 * plan still expects before the month ends. With `accounts`, only what lands in or leaves
 * those accounts.
 */
export function monthInOut({
  actual,
  snap,
  sim,
  today,
  accounts,
}: {
  /** this month's money in and out so far */
  actual: { income: number; expense: number }
  snap: PlanSnapshot
  sim: Simulation
  today: string
  accounts?: Set<number>
}): MonthInOut {
  // the projection starts today, or the day after the last transaction when that's later
  const from = snap.start > today ? snap.start : today
  const last = endOfMonth(parseISO(today))
  const monthEnd = toIso(last)
  const daysLeft = Math.max(0, differenceInCalendarDays(last, parseISO(from)) + 1)
  const counts = (accountId: number) => !accounts || accounts.has(accountId)
  const ahead = sim.events.filter(
    (e) => e.date >= from && e.date <= monthEnd && counts(e.accountId)
  )
  const item = (e: (typeof ahead)[number]): MonthItem => ({
    date: e.date,
    name: e.name,
    amount: round2(e.amount),
    pot: e.pot,
    oneOff: !!e.oneOff,
  })
  const incomes = ahead.filter((e) => e.kind === "income" && e.amount > 0).map(item)
  const bills = ahead.filter((e) => e.kind === "bill" && e.amount > 0).map(item)
  const dayToDayMonthly = snap.variable
    .filter((v) => counts(v.accountId))
    .reduce((s, v) => s + v.monthly, 0)

  const received = round2(actual.income)
  const toCome = round2(incomes.reduce((s, i) => s + i.amount, 0))
  const spent = round2(actual.expense)
  const billsToCome = round2(bills.reduce((s, b) => s + b.amount, 0))
  const dayToDayToCome = round2((dayToDayMonthly * daysLeft) / getDaysInMonth(last))
  const expectedIn = round2(received + toCome)
  const expectedOut = round2(spent + billsToCome + dayToDayToCome)
  return {
    month: today.slice(0, 7),
    from,
    daysLeft,
    in: { received, toCome, expected: expectedIn, items: incomes },
    out: {
      spent,
      billsToCome,
      dayToDayToCome,
      expected: expectedOut,
      items: bills,
    },
    net: round2(expectedIn - expectedOut),
  }
}

/** The week a date falls in, Monday to Sunday: its first day and the day after its last. */
export function weekOf(today: string) {
  const start = startOfWeek(parseISO(today), { weekStartsOn: 1 })
  return { start: toIso(start), end: toIso(addDays(start, 7)) }
}

export type BudgetRowStatus = "over" | "ahead" | "ok"

export type BudgetRow = {
  categoryId: number
  category: string
  period: BudgetPeriod
  /** the budget for its week or month */
  amount: number
  /** spent so far in this week or month */
  spent: number
  /** amount less spent; negative when over */
  left: number
  /** what an even pace would have spent by today */
  expected: number
  status: BudgetRowStatus
}

export type BudgetPeriodView = {
  /** first day, and the day after the last */
  start: string
  end: string
  /** days left, today included */
  daysLeft: number
  /** share of the period gone, today included */
  pace: number
  rows: BudgetRow[]
  budget: number
  spent: number
  left: number
}

export type BudgetsNow = {
  week: BudgetPeriodView
  month: BudgetPeriodView
  /** this month's spending in categories without a budget, biggest first */
  unbudgeted: { category: string; spent: number }[]
  unbudgetedTotal: number
  uncategorized: number
  anyBudgets: boolean
}

/** Spending well past an even pace before it counts as ahead: a share and a floor per period. */
const AHEAD_BY = 1.2
const AHEAD_MIN: Record<BudgetPeriod, number> = { week: 10, month: 20 }

/**
 * Every expense category's weekly or monthly budget against what's been spent in this
 * week (Monday to Sunday) or this month, with an even pace to today. Categories whose
 * plan cost is mostly bills land on their own dates, so they're never ahead of pace,
 * only over. Spending in categories without a budget is totalled apart.
 */
export function budgetsNow({
  categories,
  weekSpend,
  monthSpend,
  costs,
  today,
}: {
  categories: {
    id: number
    name: string
    kind: string
    monthlyBudget: number | null
    weeklyBudget: number | null
  }[]
  weekSpend: CategorySpend[]
  monthSpend: CategorySpend[]
  /** the plan's monthly cost per category, to tell bills from day-to-day spending */
  costs: CategoryCost[]
  today: string
}): BudgetsNow {
  const day = parseISO(today)
  const week = weekOf(today)
  const dayOfWeek = differenceInCalendarDays(day, parseISO(week.start)) + 1
  const daysInMonth = getDaysInMonth(day)
  const monthStart = `${today.slice(0, 7)}-01`
  const monthEnd = toIso(addDays(endOfMonth(day), 1))
  const spentIn = (list: CategorySpend[]) =>
    new Map(
      list
        .filter((s) => s.id !== null)
        .map((s) => [s.id as number, Math.max(0, s.spent)])
    )
  const weekSpent = spentIn(weekSpend)
  const monthSpent = spentIn(monthSpend)
  const billLed = new Set(
    costs.filter((c) => c.bills > 0 && c.bills >= c.dayToDay).map((c) => c.category)
  )

  const expense = categories.filter((c) => c.kind === "expense")
  const row = (
    c: (typeof expense)[number],
    period: BudgetPeriod,
    amount: number,
    pace: number
  ): BudgetRow => {
    const spent = round2(
      (period === "week" ? weekSpent : monthSpent).get(c.id) ?? 0
    )
    const expected = round2(amount * pace)
    const status: BudgetRowStatus =
      spent > amount + 0.5
        ? "over"
        : !billLed.has(c.name) && spent > expected * AHEAD_BY + AHEAD_MIN[period]
          ? "ahead"
          : "ok"
    return {
      categoryId: c.id,
      category: c.name,
      period,
      amount,
      spent,
      left: round2(amount - spent),
      expected,
      status,
    }
  }
  const view = (
    rows: BudgetRow[],
    start: string,
    end: string,
    daysLeft: number,
    pace: number
  ): BudgetPeriodView => {
    const budget = round2(rows.reduce((s, r) => s + r.amount, 0))
    const spent = round2(rows.reduce((s, r) => s + r.spent, 0))
    return {
      start,
      end,
      daysLeft,
      pace,
      rows: rows.toSorted(
        (a, b) => RANK[a.status] - RANK[b.status] || b.spent / b.amount - a.spent / a.amount
      ),
      budget,
      spent,
      left: round2(budget - spent),
    }
  }

  const weekPace = dayOfWeek / 7
  const monthPace = day.getDate() / daysInMonth
  const weekly = expense
    .filter((c) => c.weeklyBudget !== null && c.weeklyBudget > 0)
    .map((c) => row(c, "week", c.weeklyBudget!, weekPace))
  const monthly = expense
    .filter(
      (c) =>
        (c.weeklyBudget === null || c.weeklyBudget <= 0) &&
        c.monthlyBudget !== null &&
        c.monthlyBudget > 0
    )
    .map((c) => row(c, "month", c.monthlyBudget!, monthPace))
  const budgeted = new Set([...weekly, ...monthly].map((r) => r.categoryId))
  const unbudgeted = monthSpend
    .filter((s) => s.id !== null && !budgeted.has(s.id) && s.spent >= 1)
    .map((s) => ({ category: s.name, spent: round2(s.spent) }))
    .sort((a, b) => b.spent - a.spent)

  return {
    week: view(weekly, week.start, week.end, 7 - dayOfWeek + 1, weekPace),
    month: view(
      monthly,
      monthStart,
      monthEnd,
      daysInMonth - day.getDate() + 1,
      monthPace
    ),
    unbudgeted,
    unbudgetedTotal: round2(unbudgeted.reduce((s, u) => s + u.spent, 0)),
    uncategorized: round2(
      Math.max(0, monthSpend.find((s) => s.id === null)?.spent ?? 0)
    ),
    anyBudgets: weekly.length + monthly.length > 0,
  }
}

const RANK: Record<BudgetRowStatus, number> = { over: 0, ahead: 1, ok: 2 }

export type PotMonth = {
  id: number
  name: string
  /** in and out so far this month */
  in: number
  out: number
  /** still to come this month: scheduled set-asides and planned draws */
  inToCome: number
  outToCome: number
  balance: number
  cap: { amount: number; remaining: number } | null
  nextDraw: { name: string; date: string; amount: number } | null
  /** the gap between the balance and a planned draw it has to pay; 0 when covered */
  shortfall: number
  alerts: string[]
  ended: boolean
}

/**
 * Each sinking fund's month: what went in and came out so far (from its ledger), what's
 * still to come (its set-asides from the projection, and its planned draws), and where
 * it stands.
 */
export function potsThisMonth({
  ledgers,
  sim,
  today,
}: {
  ledgers: PotLedger[]
  sim: Simulation
  today: string
}): PotMonth[] {
  const month = today.slice(0, 7)
  const monthEnd = toIso(endOfMonth(parseISO(today)))
  return ledgers.map((l) => {
    // the ledger runs to today; the simulation's set-asides start after it
    const lines = l.lines.filter(
      (x) => x.date.slice(0, 7) === month && x.kind !== "reset"
    )
    const inToCome = sim.events
      .filter(
        (e) =>
          e.kind === "set-aside" &&
          e.pot === l.pot.name &&
          e.date > l.today &&
          e.date <= monthEnd
      )
      .reduce((s, e) => s + e.amount, 0)
    const outToCome = l.plannedDraws
      .filter((d) => d.date <= monthEnd)
      .reduce((s, d) => s + d.amount, 0)
    return {
      id: l.pot.id,
      name: l.pot.name,
      in: round2(lines.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0)),
      out: round2(-lines.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0)),
      inToCome: round2(inToCome),
      outToCome: round2(outToCome),
      balance: l.balance,
      cap: l.cap && { amount: l.cap.amount, remaining: l.cap.remaining },
      nextDraw: l.nextDraw && {
        name: l.nextDraw.name,
        date: l.nextDraw.date,
        amount: l.nextDraw.amount,
      },
      shortfall: l.shortfall,
      alerts: l.warnings,
      ended: l.ended,
    }
  })
}
