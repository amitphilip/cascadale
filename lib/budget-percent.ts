import "server-only"

import { getDb, must } from "@/lib/db"
import type { BudgetPeriod, Category } from "@/lib/db/schema"
import { getAverageWindow, getCategories, getRecurringInputs } from "@/lib/queries"
import { buildBudget, detectRecurring, parseBasis } from "@/lib/recurring"

// Budgets set as a percentage of projected income. The percentage is kept on the category;
// its amount is what that percentage of projected monthly income (on the default basis,
// as Recurring & budget shows it) comes to, re-set whenever income moves.

const WEEKS_PER_MONTH = 52 / 12

/** Projected monthly income on the default basis, or null before there's any data. */
export async function projectedMonthlyIncome(): Promise<number | null> {
  const window = await getAverageWindow()
  if (!window) return null
  const { txs, overrides, projections } = await getRecurringInputs(window)
  const lines = buildBudget({
    txs,
    series: detectRecurring(txs, window.last),
    window,
    defaultBasis: parseBasis(undefined),
    overrides: new Map(overrides.map((o) => [o.key, o])),
    categories: new Map(projections.map((p) => [p.categoryId, p])),
  })
  return lines.filter((l) => l.direction > 0).reduce((s, l) => s + l.projected, 0)
}

/** What `percent` of monthly income comes to, per week or per month. */
export function percentAmount(percent: number, monthlyIncome: number, period: BudgetPeriod) {
  const monthly = (monthlyIncome * percent) / 100
  return period === "week" ? monthly / WEEKS_PER_MONTH : monthly
}

/** A budget's period: weekly when it has a weekly amount. */
export const budgetPeriod = (c: Pick<Category, "weeklyBudget">): BudgetPeriod =>
  c.weeklyBudget !== null ? "week" : "month"

/**
 * Re-set the amount of every percentage budget that no longer matches income. Returns the
 * categories it changed. Amounts are compared as the database rounds them.
 */
export async function refreshPercentBudgets(categories: Category[], monthlyIncome: number) {
  const stale = categories.flatMap((c) => {
    if (c.budgetPercent === null) return []
    const percent = Number(c.budgetPercent)
    const period = budgetPeriod(c)
    const amount = percentAmount(percent, monthlyIncome, period)
    const saved = period === "week" ? Number(c.weeklyBudget) : Number(c.monthlyBudget)
    const same = period === "week" ? Math.abs(saved - amount) < 0.005 : saved === Math.round(amount)
    // a percentage of no income is no budget, but keep the percentage for when it returns
    if (same || amount <= 0) return []
    return [{ category_id: c.id, amount, period, percent }]
  })
  if (stale.length) {
    await must((await getDb()).rpc("set_category_budgets", { p_budgets: stale }))
  }
  return stale.map((s) => s.category_id)
}

/**
 * Every category, with its percentage budgets first brought in step with projected monthly
 * income, so what's read is what the budget comes to today. Also returns that income (null
 * before there's any data).
 */
export async function freshCategories() {
  const [categories, income] = await Promise.all([getCategories(), projectedMonthlyIncome()])
  if (!income || income <= 0) return { categories, income }
  const changed = await refreshPercentBudgets(categories, income)
  return { categories: changed.length ? await getCategories() : categories, income }
}
