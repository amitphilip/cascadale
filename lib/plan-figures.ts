// The monthly figures a plan stands on, from the recurring projection, the budgets you set
// and your one-off payments. Pure, so the Plan page, Cas and the tests agree.

import { differenceInCalendarDays, parseISO } from "date-fns"

import type { OneOffPlan } from "@/lib/one-offs"

const DAYS_PER_MONTH = 365.25 / 12
const round2 = (n: number) => Math.round(n * 100) / 100

export type CategoryFigure = {
  categoryId: number | null
  name: string
  /** projected monthly spend */
  projected: number
  /** the monthly budget (a weekly one's monthly equivalent), if one is set */
  budget: number | null
  budgetPeriod: "week" | "month" | null
  /** set when the budget is a percentage of income */
  budgetPercent: number | null
  /** of the projection, how much is recurring bills */
  recurring: number
}

export type OneOffFigure = {
  oneOffId: number
  name: string
  accountId: number
  total: number
  finishDate: string
  held: number
  remaining: number
  toPutIn: number
  status: OneOffPlan["status"]
  /** what to put in each month on average from now to its last payment */
  monthly: number
  /** needed now to catch up (contributions due before the next scheduled one) */
  needNow: number
}

/** What a one-off needs each month on average, from what's still to put in and the time left. */
export function oneOffFigure(
  o: { id: number; name: string; accountId: number; total: number; finishDate: string },
  plan: OneOffPlan,
  today: string
): OneOffFigure {
  const lastIn = plan.moves.filter((m) => m.kind === "in").at(-1)?.date ?? o.finishDate
  const days = Math.max(0, differenceInCalendarDays(parseISO(lastIn), parseISO(today)))
  const months = Math.max(1, days / DAYS_PER_MONTH)
  return {
    oneOffId: o.id,
    name: o.name,
    accountId: o.accountId,
    total: o.total,
    finishDate: o.finishDate,
    held: plan.held,
    remaining: plan.remaining,
    toPutIn: plan.toPutIn,
    status: plan.status,
    monthly: round2(plan.toPutIn / months),
    needNow: round2(plan.moves.filter((m) => m.now).reduce((s, m) => s + m.amount, 0)),
  }
}

export type PlanFigureSet = {
  income: number
  /** what you plan to spend: each category's budget, else its projection */
  committed: number
  /** what spending is projected at, budgets aside */
  projectedSpend: number
  oneOffs: number
  /** income less committed less one-offs */
  leftOver: number
  /** income less projected spend less one-offs: what's left if spending carries on as it is */
  leftOverAsProjected: number
  /** categories whose budget is well below how they've been running (over 15% under) */
  tightBudgets: { categoryId: number; name: string; budget: number; projected: number }[]
}

export function planFigures(
  income: number,
  categories: CategoryFigure[],
  oneOffs: OneOffFigure[]
): PlanFigureSet {
  const committed = categories.reduce((s, c) => s + (c.budget ?? c.projected), 0)
  const projectedSpend = categories.reduce((s, c) => s + c.projected, 0)
  const oneOffMonthly = oneOffs.reduce((s, o) => s + o.monthly, 0)
  return {
    income: round2(income),
    committed: round2(committed),
    projectedSpend: round2(projectedSpend),
    oneOffs: round2(oneOffMonthly),
    leftOver: round2(income - committed - oneOffMonthly),
    leftOverAsProjected: round2(income - projectedSpend - oneOffMonthly),
    tightBudgets: categories.flatMap((c) =>
      c.categoryId !== null && c.budget !== null && c.budget < c.projected * 0.85
        ? [{ categoryId: c.categoryId, name: c.name, budget: c.budget, projected: round2(c.projected) }]
        : []
    ),
  }
}
