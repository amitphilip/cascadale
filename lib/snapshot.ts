import { buildSnapshot, type PlanAccount, type PlanSnapshot } from "@/lib/plan"
import {
  buildBudget,
  detectRecurring,
  parseBasis,
  type CategoryProjection,
  type RecurringOverride,
  type RecurringSeries,
  type RecurringTx,
} from "@/lib/recurring"
import {
  loanRepaymentIds,
  pairTransfers,
  type TransferTx,
} from "@/supabase/functions/_shared/transfers"

/**
 * Your finances as the planner sees them, from the raw rows. Pure, so the Plan page, the
 * MCP tools and the tests all build the same snapshot from the same data (lib/planner.ts
 * loads the rows).
 */

/** A transaction in the planning window, transfers included. */
export type PlanTx = Omit<RecurringTx, "categoryKind"> & {
  id: number
  categoryKind: RecurringTx["categoryKind"] | "transfer"
}

/** Pseudo category for loan repayments, which are transfers into a loan account. */
export const LOAN_CATEGORY_ID = -1
export const LOAN_CATEGORY = "Loan repayments"

export type SnapshotInputs = {
  window: { start: string; last: string; days: number }
  accounts: (PlanAccount & { archived: boolean })[]
  categories: { id: number; name: string; monthlyBudget: number | null }[]
  txs: PlanTx[]
  overrides: RecurringOverride[]
  projections: CategoryProjection[]
  upcoming: { name: string; note: string | null; dueDate: string; amount: number; accountId: number | null }[]
  currency: string
  today: string
}

/**
 * The transactions the planner counts: transfers between your own accounts are left out
 * (both sides, matched by amount and date, whether or not they're categorized yet), except
 * the cash side of a loan repayment, which is a bill.
 */
export function planTransactions(txs: PlanTx[], accounts: { id: number; type: string }[]) {
  // only uncategorized money and transfers can be one side of a transfer; a categorized
  // salary that happens to match a payment elsewhere is still a salary
  const candidates: TransferTx[] = txs.filter(
    (t) => t.categoryKind === null || t.categoryKind === "transfer"
  )
  const pairs = pairTransfers(candidates)
  const loans = loanRepaymentIds(candidates, accounts, pairs)
  const paired = new Set(pairs.flatMap((p) => [p.outId, p.inId]))
  const out: RecurringTx[] = []
  for (const t of txs) {
    if (loans.has(t.id)) {
      out.push({
        date: t.date,
        accountId: t.accountId,
        description: t.description,
        amount: t.amount,
        categoryId: LOAN_CATEGORY_ID,
        categoryKind: "expense",
        ruleId: null,
        ruleNote: t.ruleNote,
      })
    } else if (t.categoryKind !== "transfer" && !paired.has(t.id)) {
      out.push({
        date: t.date,
        accountId: t.accountId,
        description: t.description,
        amount: t.amount,
        categoryId: t.categoryId,
        categoryKind: t.categoryKind,
        ruleId: t.ruleId,
        ruleNote: t.ruleNote,
      })
    }
  }
  return { txs: out, pairs, loanRepayments: loans }
}

export function snapshotFromData(input: SnapshotInputs): {
  snapshot: PlanSnapshot
  series: RecurringSeries[]
  txs: RecurringTx[]
} {
  const accounts = input.accounts.filter((a) => !a.archived)
  const { txs } = planTransactions(input.txs, input.accounts)
  const overrideByKey = new Map(input.overrides.map((o) => [o.key, o]))
  const series = detectRecurring(txs, input.window.last)
  const lines = buildBudget({
    txs,
    series,
    window: input.window,
    defaultBasis: parseBasis(undefined),
    overrides: overrideByKey,
    categories: new Map(input.projections.map((p) => [p.categoryId, p])),
  })
  const catById = new Map(input.categories.map((c) => [c.id, c]))
  const snapshot = buildSnapshot({
    lines,
    series,
    txs,
    overrides: overrideByKey,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balance })),
    categoryName: (l) =>
      l.categoryId === null
        ? `Uncategorized ${l.direction > 0 ? "in" : "out"}`
        : l.categoryId === LOAN_CATEGORY_ID
          ? LOAN_CATEGORY
          : (catById.get(l.categoryId)?.name ?? "Unknown"),
    dataEnd: input.window.last,
    today: input.today,
    currency: input.currency,
    budgets: new Map(input.categories.map((c) => [c.id, c.monthlyBudget])),
    upcoming: input.upcoming.map((u) => ({
      name: u.note ? `${u.name} (${u.note})` : u.name,
      date: u.dueDate,
      amount: u.amount,
      accountId: u.accountId,
    })),
  })
  return { snapshot, series, txs }
}
