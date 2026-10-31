import "server-only"

import { connection } from "next/server"

import { COLUMNS, DbError, getDb, must, selectAll } from "@/lib/db"
import type {
  AccountType,
  Asset,
  Category,
  CategoryKind,
  CategoryProjectionRow,
  CategorySource,
  CheckIn,
  PlanAction,
  PlanMessage,
  PlanThread,
  RecurringOverrideRow,
  RuleKind,
  RuleSource,
  UpcomingExpense,
} from "@/lib/db/schema"
import { DEFAULT_MONEY, type MoneyFormat } from "@/lib/format"
import type { CategoryProjection, RecurringOverride, RecurringTx } from "@/lib/recurring"
import { merchantKey } from "@/lib/rules"
import type { PlanTx } from "@/lib/snapshot"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

async function db() {
  await connection()
  return getDb()
}

export async function getSettings(): Promise<MoneyFormat> {
  const rows = await must<{ key: string; value: string }[]>(
    (await db()).from("settings").select("key, value")
  )
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { currency: map.currency ?? DEFAULT_MONEY.currency, locale: map.locale ?? DEFAULT_MONEY.locale }
}

export async function getAccountsWithBalances() {
  const rows = await must<
    {
      id: number
      name: string
      type: AccountType
      institution: string | null
      opening_balance: number
      archived: boolean
      tx_total: number
      tx_count: number
      last_date: string | null
    }[]
  >((await db()).rpc("accounts_with_balances"))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    institution: r.institution,
    openingBalance: Number(r.opening_balance),
    archived: r.archived,
    txTotal: Number(r.tx_total),
    txCount: r.tx_count,
    lastDate: r.last_date,
    balance: Math.round((Number(r.opening_balance) + Number(r.tx_total)) * 100) / 100,
  }))
}

export async function getAssets() {
  const rows = await must<Asset[]>(
    (await db()).from("assets").select(COLUMNS.assets).order("id")
  )
  return rows.map((a) => ({ ...a, value: Number(a.value) }))
}

export async function getPlanActions() {
  return must<PlanAction[]>(
    (await db())
      .from("plan_actions")
      .select(COLUMNS.planActions)
      .order("done_at", { nullsFirst: true })
      .order("id")
  )
}

/** Every transaction's account, date and amount, for rebuilding balances over time. */
export async function getTransactionAmounts() {
  const client = await db()
  const rows = await selectAll<{ accountId: number; date: string; amount: number }>((from, to) =>
    client
      .from("transactions")
      .select("accountId:account_id, date, amount")
      .order("id")
      .range(from, to)
  )
  return rows.map((t) => ({ ...t, amount: Number(t.amount) }))
}

export async function getCategories() {
  return must<Category[]>(
    (await db())
      .from("categories")
      .select(COLUMNS.categories)
      .order("kind")
      .order("name")
  )
}

export async function getCategoriesWithUsage() {
  const rows = await must<
    {
      id: number
      name: string
      kind: CategoryKind
      monthly_budget: number | null
      tx_count: number
    }[]
  >((await db()).rpc("categories_with_usage"))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    monthlyBudget: r.monthly_budget === null ? null : Number(r.monthly_budget),
    txCount: r.tx_count,
  }))
}

export async function getRules() {
  const d = await db()
  return selectAll<{ id: number; pattern: string; categoryId: number; categoryName: string }>(
    (from, to) =>
      d
        .from("rules")
        .select("id, pattern, categoryId:category_id, ...categories!inner(categoryName:name)")
        .eq("kind", "contains")
        .order("pattern")
        .order("id")
        .range(from, to)
  )
}

/** Every rule with how many transactions it categorized, busiest first. */
export async function getRuleTags() {
  return must<
    {
      id: number
      pattern: string
      kind: RuleKind
      source: RuleSource
      categoryId: number
      txCount: number
    }[]
  >((await db()).rpc("rule_tags"))
}

export type ReviewFilter = "all" | "uncategorized" | "low" | "ai" | "rules"

/** Uncategorized transactions grouped by merchant, biggest groups first. */
export async function getUncategorizedMerchants(q?: string) {
  const needle = q?.toLowerCase()
  const d = await db()
  const rows = await selectAll<{ description: string; amount: number }>((from, to) =>
    d
      .from("transactions")
      .select("description, amount")
      .is("category_id", null)
      .order("id")
      .range(from, to)
  )
  const groups = new Map<string, { key: string; example: string; count: number; total: number }>()
  for (const r of rows) {
    const key = merchantKey(r.description)
    if (needle && !key.includes(needle) && !r.description.toLowerCase().includes(needle)) continue
    const g = groups.get(key) ?? { key, example: r.description, count: 0, total: 0 }
    g.count++
    g.total += r.amount
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** Below this, an auto-categorized merchant is flagged for review. */
export const LOW_CONFIDENCE = 70

/**
 * One row per rule that has categorized at least one transaction, with the
 * average confidence of its auto-categorized transactions.
 */
export async function getRuleReview(filter: ReviewFilter = "all", q?: string) {
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null
  const rows = await must<
    {
      id: number
      pattern: string
      kind: RuleKind
      source: RuleSource
      rule_confidence: number
      category_id: number
      tx_count: number
      auto_count: number
      total: number
      confidence: number | null
      example: string
      note: string | null
      reason: string | null
    }[]
  >((await db()).rpc("rule_review", { p_like: like }))
  return rows
    .map((r) => ({
      id: r.id,
      pattern: r.pattern,
      kind: r.kind,
      source: r.source,
      categoryId: r.category_id,
      txCount: r.tx_count,
      autoCount: r.auto_count,
      total: Number(r.total),
      confidence: r.confidence ?? r.rule_confidence,
      example: r.example,
      note: r.note,
      reason: r.reason,
    }))
    .filter((r) => {
      if (filter === "uncategorized") return false
      if (filter === "low") return r.confidence < LOW_CONFIDENCE
      if (filter === "ai") return r.source === "ai"
      if (filter === "rules") return r.source !== "ai"
      return true
    })
}

/** Counts of transactions by how they were categorized. */
export async function getCategorizationStats() {
  const [row] = await must<
    {
      total: number
      uncategorized: number
      manual: number
      rule: number
      ai: number
      low: number
    }[]
  >((await db()).rpc("categorization_stats", { p_low: LOW_CONFIDENCE }))
  return row
}

export type TransactionFilters = {
  account?: number
  category?: number | "none"
  rule?: number
  month?: string // yyyy-MM
  q?: string
  page?: number
}

export const PAGE_SIZE = 100

function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number)
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  return { start: `${month}-01`, end: next }
}

export async function getTransactions(f: TransactionFilters) {
  const d = await db()
  const range = f.month && /^\d{4}-\d{2}$/.test(f.month) ? monthRange(f.month) : null
  const page = Math.max(1, f.page ?? 1)

  let list = d
    .from("transactions")
    .select(
      `id, date, description, amount, notes, source, accountId:account_id,
      categoryId:category_id, categorySource:category_source,
      categoryConfidence:category_confidence, ...accounts!inner(accountName:name)`
    )
  if (f.account) list = list.eq("account_id", f.account)
  if (f.category === "none") list = list.is("category_id", null)
  else if (f.category) list = list.eq("category_id", f.category)
  if (f.rule) list = list.eq("rule_id", f.rule)
  if (range) list = list.gte("date", range.start).lt("date", range.end)
  if (f.q) list = list.ilike("description", `%${f.q}%`)

  const [rows, [totals]] = await Promise.all([
    must<
      {
        id: number
        date: string
        description: string
        amount: number
        notes: string | null
        source: "import" | "manual"
        accountId: number
        accountName: string
        categoryId: number | null
        categorySource: CategorySource | null
        categoryConfidence: number | null
      }[]
    >(
      list
        .order("date", { ascending: false })
        .order("id", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    ),
    must<{ count: number; inflow: number; outflow: number }[]>(
      d.rpc("transaction_totals", {
        p_account: f.account ?? null,
        p_category: typeof f.category === "number" ? f.category : null,
        p_uncategorized: f.category === "none",
        p_rule: f.rule ?? null,
        p_start: range?.start ?? null,
        p_end: range?.end ?? null,
        p_q: f.q || null,
      })
    ),
  ])

  return {
    rows,
    total: totals.count,
    inflow: Number(totals.inflow),
    outflow: Number(totals.outflow),
    page,
    pageCount: Math.max(1, Math.ceil(totals.count / PAGE_SIZE)),
  }
}

export async function getTransactionMonths() {
  return must<string[]>((await db()).rpc("transaction_months"))
}

export async function getUncategorizedCount() {
  const { count, error } = await (await db())
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .is("category_id", null)
  if (error) throw new DbError(error)
  return count ?? 0
}

/**
 * Income and spending per month. Transfer-kind categories are excluded;
 * uncategorized money in/out counts as income/spending.
 */
export async function getMonthlyCashflow(endMonth: string, months = 12) {
  const [ey, em] = endMonth.split("-").map(Number)
  const list: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const dt = new Date(ey, em - 1 - i, 1)
    list.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`)
  }
  const start = `${list[0]}-01`
  const { end } = monthRange(endMonth)
  const rows = await must<{ month: string; income: number; expense: number }[]>(
    (await db()).rpc("monthly_cashflow", { p_start: start, p_end: end })
  )
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  return list.map((month) => {
    const r = byMonth.get(month)
    const income = r ? Number(r.income) : 0
    const expense = r ? Number(r.expense) : 0
    return { month, income, expense, net: Math.round((income - expense) * 100) / 100 }
  })
}

export async function getLatestMonth() {
  const [row] = await must<{ date: string }[]>(
    (await db())
      .from("transactions")
      .select("date")
      .order("date", { ascending: false })
      .limit(1)
  )
  return row ? row.date.slice(0, 7) : null
}

/** Net spending per expense category for a month (refunds reduce spend). */
export async function getCategorySpend(month: string) {
  const { start, end } = monthRange(month)
  const rows = await must<
    { id: number | null; name: string | null; budget: number | null; spent: number }[]
  >((await db()).rpc("category_spend", { p_start: start, p_end: end }))
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "Uncategorized",
    budget: r.budget === null ? null : Number(r.budget),
    spent: Number(r.spent),
  }))
}

export async function getStatements() {
  const rows = await must<
    {
      id: number
      fileName: string
      storedName: string
      rowCount: number
      insertedCount: number
      periodStart: string | null
      periodEnd: string | null
      importedAt: string
      accountName: string
    }[]
  >(
    (await db())
      .from("statements")
      .select(
        `id, fileName:file_name, storedName:stored_name, rowCount:row_count,
        insertedCount:inserted_count, periodStart:period_start, periodEnd:period_end,
        importedAt:imported_at, ...accounts!inner(accountName:name)`
      )
      .order("imported_at", { ascending: false })
  )
  return rows
}

export type StatementLine = { id: number | null; name: string; month: number; window: number }

/** Date range that averages are taken over: [start, end), plus its last day and length. */
export type AverageWindow = { start: string; end: string; last: string; days: number }

/**
 * The window that averages are taken over: up to `months` months ending with the latest
 * transaction, starting no earlier than the first one. It doesn't depend on the month being
 * viewed, so averages stay put while browsing months.
 */
export async function getAverageWindow(months = 12): Promise<AverageWindow | null> {
  const [r] = await must<
    {
      start_date: string | null
      end_date: string | null
      last_date: string | null
      days: number | null
    }[]
  >((await db()).rpc("average_window", { p_months: months }))
  if (!r?.start_date || !r.end_date || !r.last_date) return null
  return {
    start: r.start_date,
    end: r.end_date,
    last: r.last_date,
    days: Math.max(Number(r.days), 1),
  }
}

/**
 * Income statement lines for a month, plus totals over the averaging window.
 * Amounts are net per category (refunds reduce spend). Transfers are excluded;
 * uncategorized money in/out is reported as its own income/expense line.
 */
export async function getIncomeStatement(month: string, window: AverageWindow | null) {
  const { start, end } = monthRange(month)
  const w = window ?? { start, end }
  const rows = await must<
    {
      id: number | null
      name: string | null
      kind: "income" | "expense"
      month_total: number
      window_total: number
    }[]
  >(
    (await db()).rpc("income_statement", {
      p_start: start,
      p_end: end,
      p_wstart: w.start,
      p_wend: w.end,
    })
  )
  const income: StatementLine[] = []
  const expense: StatementLine[] = []
  for (const r of rows) {
    // expenses are reported as positive amounts spent
    const sign = r.kind === "income" ? 1 : -1
    const line = {
      id: r.id,
      name: r.name ?? "Uncategorized",
      month: sign * Number(r.month_total),
      window: sign * Number(r.window_total),
    }
    ;(r.kind === "income" ? income : expense).push(line)
  }
  const byMonth = (a: StatementLine, b: StatementLine) => b.month - a.month || b.window - a.window
  return { income: income.sort(byMonth), expense: expense.sort(byMonth) }
}

export type BalanceLine = {
  id: number
  name: string
  type: string
  /** balance at the end of the month */
  balance: number
  /** average end-of-day balance over the averaging window */
  average: number
  /** change in balance over the averaging window */
  windowChange: number
}

/**
 * Active account balances as of the end of a month (opening balance + transactions before then),
 * plus the average daily balance and total change over the averaging window.
 */
export async function getBalancesAsOf(month: string, window: AverageWindow | null) {
  const { end } = monthRange(month)
  const w = window ?? { start: end, end, days: 1 }
  const rows = await must<
    {
      id: number
      name: string
      type: string
      opening: number
      end_total: number
      start_total: number
      window_total: number
      weighted: number
    }[]
  >((await db()).rpc("balances_as_of", { p_end: end, p_wstart: w.start, p_wend: w.end }))
  const round = (n: number) => Math.round(n * 100) / 100
  return rows.map((r): BalanceLine => {
    const startBalance = Number(r.opening) + Number(r.start_total)
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      balance: round(Number(r.opening) + Number(r.end_total)),
      average: round(startBalance + Number(r.weighted) / w.days),
      windowChange: round(Number(r.window_total)),
    }
  })
}

/**
 * Everything the recurring/budget page needs: non-transfer transactions over the averaging
 * window with the rule that categorized each, and your category and merchant settings.
 */
export async function getRecurringInputs(window: AverageWindow | null) {
  const d = await db()
  const [txs, overrides, projections] = await Promise.all([
    window
      ? must<RecurringTx[]>(
          d.rpc("recurring_transactions", { p_start: window.start, p_end: window.end })
        )
      : [],
    must<RecurringOverrideRow[]>(d.from("recurring_overrides").select(COLUMNS.recurringOverrides)),
    must<CategoryProjectionRow[]>(
      d.from("category_projections").select(COLUMNS.categoryProjections)
    ),
  ])
  return {
    txs: txs.map((r): RecurringTx => ({ ...r, amount: Number(r.amount) })),
    overrides: overrides.map(
      (o): RecurringOverride => ({
        key: o.key,
        basis: o.basis,
        growthRate: o.growthRate,
        amount: o.amount,
        excluded: o.excluded,
      })
    ),
    projections: projections.map(
      (p): CategoryProjection => ({
        categoryId: p.categoryId,
        basis: p.basis,
        growthRate: p.growthRate,
        amount: p.amount,
      })
    ),
  }
}

/** Every transaction in the averaging window, transfers included, for the planner. */
export async function getPlanTransactions(window: AverageWindow) {
  const rows = await must<PlanTx[]>(
    (await db()).rpc("plan_transactions", { p_start: window.start, p_end: window.end })
  )
  return rows.map((r): PlanTx => ({ ...r, amount: Number(r.amount) }))
}

/** The latest planning conversation and its messages, oldest first. */
export async function getPlanThread() {
  const d = await db()
  const [thread] = await must<PlanThread[]>(
    d.from("plan_threads").select(COLUMNS.planThreads).order("id", { ascending: false }).limit(1)
  )
  if (!thread) return null
  const messages = await must<PlanMessage[]>(
    d.from("plan_messages").select(COLUMNS.planMessages).eq("thread_id", thread.id).order("id")
  )
  return { ...thread, messages }
}

/** One-off expenses from today on, soonest first. */
export async function getUpcomingExpenses() {
  return must<UpcomingExpense[]>(
    (await db())
      .from("upcoming_expenses")
      .select(COLUMNS.upcomingExpenses)
      .gte("due_date", todayLocal())
      .order("due_date")
      .order("id")
  )
}

/** Check-ins, newest first. */
export async function getCheckIns(limit = 10) {
  return must<CheckIn[]>(
    (await db())
      .from("check_ins")
      .select(COLUMNS.checkIns)
      .order("id", { ascending: false })
      .limit(limit)
  )
}
