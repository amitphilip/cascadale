import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek } from "date-fns"

import type { Category } from "@/lib/db/schema"

// Budget tracking, for the Overview and Cas: each budget against its own period (a weekly one this
// week, Monday to Sunday; a monthly one this calendar month) and how far into it we are.

const iso = (d: Date) => format(d, "yyyy-MM-dd")

/** A period as [start, end): `end` is the day after its last. */
export type Range = { start: string; end: string; days: number }

/** This week, Monday to Sunday. */
export function weekOf(today: string): Range {
  const start = startOfWeek(parseISO(today), { weekStartsOn: 1 })
  return { start: iso(start), end: iso(addDays(start, 7)), days: 7 }
}

/** This calendar month. */
export function monthOf(today: string): Range {
  const [y, m] = today.split("-").map(Number)
  const start = `${today.slice(0, 7)}-01`
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  return { start, end, days: differenceInCalendarDays(parseISO(end), parseISO(start)) }
}

/** Share of the period gone, counting today as gone: 1 on its last day. */
export function elapsed(range: Range, today: string) {
  const done = differenceInCalendarDays(parseISO(today), parseISO(range.start)) + 1
  return Math.min(1, Math.max(0, done / range.days))
}

export type Pace = "over" | "ahead" | "on_pace"

export const PACE_LABELS: Record<Pace, string> = {
  over: "Over budget",
  ahead: "Ahead of pace",
  on_pace: "On pace",
}

export type BudgetTrack = {
  id: number
  name: string
  period: "week" | "month"
  budget: number
  /** net of refunds, never below zero */
  spent: number
  left: number
  /** what the budget allows by now, at an even pace */
  expected: number
  pace: Pace
  percent: number | null
}

/** Spending more than this share over the even pace counts as ahead of pace. */
const AHEAD_SLACK = 0.1

/**
 * Every expense category with a budget, tracked against its period. Over-budget ones come
 * first, then those ahead of pace, then the rest by how much of their budget is spent.
 */
export function trackBudgets(
  categories: Category[],
  spend: { month: Map<number, number>; week: Map<number, number> },
  today: string
): BudgetTrack[] {
  const share = { week: elapsed(weekOf(today), today), month: elapsed(monthOf(today), today) }
  const rank: Record<Pace, number> = { over: 0, ahead: 1, on_pace: 2 }
  return categories
    .filter((c) => c.kind === "expense" && c.monthlyBudget !== null && Number(c.monthlyBudget) > 0)
    .map((c): BudgetTrack => {
      const period = c.weeklyBudget !== null ? "week" : "month"
      const budget = Number(period === "week" ? c.weeklyBudget : c.monthlyBudget)
      const spent = Math.max(0, spend[period].get(c.id) ?? 0)
      const expected = budget * share[period]
      const pace: Pace =
        spent > budget ? "over" : spent > expected * (1 + AHEAD_SLACK) ? "ahead" : "on_pace"
      return {
        id: c.id,
        name: c.name,
        period,
        budget,
        spent,
        left: budget - spent,
        expected,
        pace,
        percent: c.budgetPercent === null ? null : Number(c.budgetPercent),
      }
    })
    .sort((a, b) => rank[a.pace] - rank[b.pace] || b.spent / b.budget - a.spent / a.budget)
}
