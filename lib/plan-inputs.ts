import "server-only"

import { addDays, format, parseISO } from "date-fns"

import { budgetPeriod, refreshPercentBudgets } from "@/lib/budget-percent"
import { monthOf } from "@/lib/budget-tracking"
import { paysDue } from "@/lib/income"
import { planOneOff } from "@/lib/one-offs"
import { oneOffFigure, planFigures, type CategoryFigure } from "@/lib/plan-figures"
import {
  getAccountHolders,
  getAccountsWithBalances,
  getAverageWindow,
  getCategories,
  getOneOffs,
  getPeople,
  getRecurringInputs,
  getSettings,
} from "@/lib/queries"
import { buildBudget, CADENCE_LABELS, detectRecurring, parseBasis } from "@/lib/recurring"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const round2 = (n: number) => Math.round(n * 100) / 100
const DEBT_TYPES = ["loan", "credit_line"]

/**
 * Everything a plan is made from, as Cas reads it and the Plan page shows it: projected
 * income and its sources, each expense category's projection against its budget, recurring
 * bills, one-off payments with what they still need, the pays still due this month,
 * accounts and who holds them. Null before there are any transactions.
 */
export async function loadPlanInputs() {
  const today = todayLocal()
  const window = await getAverageWindow()
  if (!window) return null
  const [{ txs, overrides, projections }, categories, accounts, { oneOffs }, holders, people, fmt] =
    await Promise.all([
      getRecurringInputs(window),
      getCategories(),
      getAccountsWithBalances(),
      getOneOffs(),
      getAccountHolders(),
      getPeople(),
      getSettings(),
    ])
  const lines = buildBudget({
    txs,
    series: detectRecurring(txs, window.last),
    window,
    defaultBasis: parseBasis(undefined),
    overrides: new Map(overrides.map((o) => [o.key, o])),
    categories: new Map(projections.map((p) => [p.categoryId, p])),
  })
  const catById = new Map(categories.map((c) => [c.id, c]))
  const nameOf = (id: number | null, direction: number) =>
    id === null ? `Uncategorized ${direction > 0 ? "in" : "out"}` : (catById.get(id)?.name ?? "Unknown")
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  const personName = new Map(people.map((p) => [p.id, p.name]))

  const incomeLines = lines.filter((l) => l.direction > 0)
  const income = incomeLines.reduce((s, l) => s + l.projected, 0)
  // keep percentage budgets in step before reading them
  if (income > 0) await refreshPercentBudgets(categories, income)

  const expense: CategoryFigure[] = lines
    .filter((l) => l.direction < 0)
    .map((l) => {
      const c = l.categoryId === null ? undefined : catById.get(l.categoryId)
      return {
        categoryId: l.categoryId,
        name: nameOf(l.categoryId, -1),
        projected: round2(l.projected),
        budget: c?.monthlyBudget == null ? null : Number(c.monthlyBudget),
        budgetPeriod: c?.monthlyBudget == null ? null : budgetPeriod(c),
        budgetPercent: c?.budgetPercent == null ? null : Number(c.budgetPercent),
        recurring: round2(l.recurring),
      }
    })
    .sort((a, b) => b.projected - a.projected)

  const live = oneOffs
    .map((o) => ({ o, plan: planOneOff(o, o.linked, today) }))
    .filter(({ plan }) => plan.status !== "paid")
  const oneOffFigures = live.map(({ o, plan }) => oneOffFigure(o, plan, today))

  const active = accounts.filter((a) => !a.archived)
  return {
    today,
    currency: fmt.currency,
    figures: planFigures(income, expense, oneOffFigures),
    incomeSources: incomeLines.flatMap((l) => {
      const regular = l.series.filter((s) => !s.ended && !s.excluded)
      const other = round2(l.other.monthly)
      return [
        ...regular.map((s) => ({
          name: s.example,
          category: nameOf(l.categoryId, 1),
          cadence: CADENCE_LABELS[s.cadence],
          amount: round2(s.latest),
          monthly: round2(s.monthly),
          nextDate: s.nextDate,
          account: accountName.get(s.accountId) ?? null,
          accountId: s.accountId,
        })),
        ...(other > 0
          ? [{ name: `Other ${nameOf(l.categoryId, 1)}`, category: nameOf(l.categoryId, 1), cadence: "Irregular", amount: other, monthly: other, nextDate: null, account: null, accountId: null }]
          : []),
      ]
    }),
    paysDue: paysDue(
      incomeLines.flatMap((l) => l.series.filter((s) => !s.ended && !s.excluded)),
      today,
      format(addDays(parseISO(monthOf(today).end), -1), "yyyy-MM-dd")
    ).map((p) => ({ ...p, account: accountName.get(p.accountId) ?? null })),
    categories: expense,
    /** the regular bills still to go out this month, each with its category, like paysDue */
    billsDue: lines
      .filter((l) => l.direction < 0)
      .flatMap((l) =>
        paysDue(
          l.series.filter((s) => !s.ended && !s.excluded),
          today,
          format(addDays(parseISO(monthOf(today).end), -1), "yyyy-MM-dd")
        ).map((p) => ({ ...p, categoryId: l.categoryId }))
      ),
    bills: lines
      .filter((l) => l.direction < 0)
      .flatMap((l) =>
        l.series
          .filter((s) => !s.ended && !s.excluded)
          .map((s) => ({
            name: s.example,
            category: nameOf(l.categoryId, -1),
            cadence: CADENCE_LABELS[s.cadence],
            amount: round2(s.latest),
            monthly: round2(s.monthly),
            nextDate: s.nextDate,
            account: accountName.get(s.accountId) ?? null,
          }))
      )
      .sort((a, b) => b.monthly - a.monthly),
    oneOffs: oneOffFigures.map((f) => ({ ...f, account: accountName.get(f.accountId) ?? null })),
    accounts: active.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      balance: a.balance,
      isDebt: DEBT_TYPES.includes(a.type) || a.balance < 0,
      interestRate: a.interestRate,
      holder: holders.get(a.id) ? (personName.get(holders.get(a.id)!) ?? "Someone") : "Joint",
    })),
  }
}

export type PlanInputs = NonNullable<Awaited<ReturnType<typeof loadPlanInputs>>>
