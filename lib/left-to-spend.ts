import "server-only"

import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns"

import { monthOf } from "@/lib/budget-tracking"
import { loadPlanInputs } from "@/lib/plan-inputs"
import { formatMoney } from "@/lib/format"
import { getCategories, getCategorySpendBetween, getSettings } from "@/lib/queries"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

// Home's one number: what's left to spend this month and stay on plan. It counts only the
// flexible budgets (groceries, dining out, shopping…), not the bills, which go out whatever
// you do; and it takes off anything spent in a category with no budget, since the plan
// didn't make room for it. Budgets are the household's, so the My view shows the same figure.

/** A category whose projection is at least this share recurring bills is a bill, not flexible. */
const BILL_SHARE = 0.5

const round2 = (n: number) => Math.round(n * 100) / 100

export type LeftToSpend = {
  /** can be negative: over plan */
  amount: number
  /** amount / daysLeft, 0 when amount <= 0 */
  perDay: number
  /** days left in the month, counting today */
  daysLeft: number
  /** the month's last day, yyyy-MM-dd */
  periodEnd: string
  /** the flexible budgets for the month */
  budgeted: number
  /** spent against them so far */
  spent: number
  /** spending this month in categories with no budget */
  unbudgeted: number
  /** one plain sentence on how the number is made */
  basis: string
  whose: "me" | "family"
}

export async function getLeftToSpend(view: "me" | "family"): Promise<LeftToSpend> {
  const today = todayLocal()
  const month = monthOf(today)
  const periodEnd = format(addDays(parseISO(month.end), -1), "yyyy-MM-dd")
  const daysLeft = differenceInCalendarDays(parseISO(month.end), parseISO(today))

  const [inputs, categories, spend, fmt] = await Promise.all([
    loadPlanInputs(),
    getCategories(),
    getCategorySpendBetween(month.start, month.end),
    getSettings(),
  ])
  const spentIn = new Map(spend.flatMap((r) => (r.id === null ? [] : [[r.id, Math.max(0, r.spent)] as const])))
  const projection = new Map((inputs?.categories ?? []).map((c) => [c.categoryId, c]))

  const expense = categories.filter((c) => c.kind === "expense")
  const budgetedCats = expense.filter((c) => c.monthlyBudget !== null && Number(c.monthlyBudget) > 0)
  const flexible = budgetedCats.filter((c) => {
    const p = projection.get(c.id)
    return !p || p.projected <= 0 || p.recurring / p.projected < BILL_SHARE
  })
  const budgetedIds = new Set(budgetedCats.map((c) => c.id))

  const budgeted = flexible.reduce((s, c) => s + Number(c.monthlyBudget), 0)
  const spent = flexible.reduce((s, c) => s + (spentIn.get(c.id) ?? 0), 0)
  // uncategorized spending (id null) isn't counted here: it shows up in the inbox to sort out
  const unbudgeted = spend
    .filter((r) => r.id !== null && !budgetedIds.has(r.id) && expense.some((c) => c.id === r.id))
    .reduce((s, r) => s + Math.max(0, r.spent), 0)

  const amount = round2(budgeted - spent - unbudgeted)
  const perDay = amount > 0 && daysLeft > 0 ? round2(amount / daysLeft) : 0

  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const basis = [
    `${money(budgeted)} of flexible budgets this month, less ${money(spent)} spent against them`,
    unbudgeted > 0 ? ` and ${money(unbudgeted)} spent with no budget` : "",
    ". Bills aren't counted; they're already planned for.",
    view === "me" ? " Budgets are shared, so this is the household's figure." : "",
  ].join("")

  return {
    amount,
    perDay,
    daysLeft,
    periodEnd,
    budgeted: round2(budgeted),
    spent: round2(spent),
    unbudgeted: round2(unbudgeted),
    basis,
    whose: view,
  }
}
