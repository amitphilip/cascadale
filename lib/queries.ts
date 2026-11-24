import "server-only"

import type { PostgrestError } from "@supabase/supabase-js"
import { cache } from "react"
import { connection } from "next/server"

import { COLUMNS, DbError, getDb, must, selectAll, selectAllAtOnce } from "@/lib/db"
import type {
  AccountType,
  Asset,
  Category,
  CategoryKind,
  CategoryProjectionRow,
  CategorySource,
  OneOff,
  RecurringOverrideRow,
  RuleKind,
  RuleSource,
} from "@/lib/db/schema"
import { DEFAULT_MONEY, type MoneyFormat } from "@/lib/format"
import type {
  CategoryProjection,
  RecurringOverride,
  RecurringTx,
} from "@/lib/recurring"
import type { LinkedTx } from "@/lib/one-offs"
import { merchantKey } from "@/lib/rules"
import type { HomeView, Person } from "@/lib/views"
import type { WindowTx } from "@/lib/counted-transactions"

async function db() {
  await connection()
  return getDb()
}

export const getSettings = cache(async function getSettings(): Promise<MoneyFormat> {
  const rows = await must<{ key: string; value: string }[]>(
    (await db()).from("settings").select("key, value")
  )
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return {
    currency: map.currency ?? DEFAULT_MONEY.currency,
    locale: map.locale ?? DEFAULT_MONEY.locale,
  }
})

export const getAccountsWithBalances = cache(async function getAccountsWithBalances() {
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
  // interest rates aren't in the balances function, so read them alongside
  const rates = new Map(
    (
      await must<{ id: number; interest_rate: number | null }[]>(
        (await db()).from("accounts").select("id, interest_rate")
      )
    ).map((r) => [r.id, r.interest_rate === null ? null : Number(r.interest_rate)])
  )
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
    interestRate: rates.get(r.id) ?? null,
    balance:
      Math.round((Number(r.opening_balance) + Number(r.tx_total)) * 100) / 100,
  }))
})

export async function getAssets() {
  const rows = await must<Asset[]>(
    (await db()).from("assets").select(COLUMNS.assets).order("id")
  )
  return rows.map((a) => ({ ...a, value: Number(a.value) }))
}

/**
 * Every transaction's account, date and amount, for rebuilding balances over time; with
 * `after`, only those after that date.
 */
export async function getTransactionAmounts(after?: string) {
  const client = await db()
  const rows = await selectAllAtOnce<{
    accountId: number
    date: string
    amount: number
  }>((from, to, count) => {
    const q = client.from("transactions").select("accountId:account_id, date, amount", { count })
    return (after ? q.gt("date", after) : q).order("id").range(from, to)
  })
  return rows.map((t) => ({ ...t, amount: Number(t.amount) }))
}

export const getCategories = cache(async function getCategories() {
  return must<Category[]>(
    (await db())
      .from("categories")
      .select(COLUMNS.categories)
      .order("kind")
      .order("name")
  )
})

export async function getCategoriesWithUsage() {
  const rows = await must<
    {
      id: number
      name: string
      kind: CategoryKind
      monthly_budget: number | null
      weekly_budget: number | null
      budget_percent: number | null
      tx_count: number
    }[]
  >((await db()).rpc("categories_with_usage"))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    monthlyBudget: r.monthly_budget === null ? null : Number(r.monthly_budget),
    weeklyBudget: r.weekly_budget === null ? null : Number(r.weekly_budget),
    budgetPercent: r.budget_percent === null ? null : Number(r.budget_percent),
    txCount: r.tx_count,
  }))
}

export async function getRules() {
  const d = await db()
  return selectAll<{
    id: number
    pattern: string
    categoryId: number
    categoryName: string
  }>((from, to) =>
    d
      .from("rules")
      .select(
        "id, pattern, categoryId:category_id, ...categories!inner(categoryName:name)"
      )
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
  const rows = await selectAll<{ description: string; amount: number }>(
    (from, to) =>
      d
        .from("transactions")
        .select("description, amount")
        .is("category_id", null)
        .order("id")
        .range(from, to)
  )
  const groups = new Map<
    string,
    { key: string; example: string; count: number; total: number }
  >()
  for (const r of rows) {
    const key = merchantKey(r.description)
    if (
      needle &&
      !key.includes(needle) &&
      !r.description.toLowerCase().includes(needle)
    )
      continue
    const g = groups.get(key) ?? {
      key,
      example: r.description,
      count: 0,
      total: 0,
    }
    g.count++
    g.total += r.amount
    groups.set(key, g)
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.key.localeCompare(b.key)
  )
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
  const next =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  return { start: `${month}-01`, end: next }
}

export async function getTransactions(f: TransactionFilters) {
  const d = await db()
  const range =
    f.month && /^\d{4}-\d{2}$/.test(f.month) ? monthRange(f.month) : null
  const page = Math.max(1, f.page ?? 1)

  let list = d.from("transactions").select(
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
  const { count, error } = await (
    await db()
  )
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
    list.push(
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`
    )
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
    return {
      month,
      income,
      expense,
      net: Math.round((income - expense) * 100) / 100,
    }
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
  return getCategorySpendBetween(start, end)
}

/** Net spending per expense category over [start, end), e.g. this week (refunds reduce spend). */
export async function getCategorySpendBetween(start: string, end: string) {
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

/**
 * Money in and out over a month, transfers left out; with `accountIds`, only what landed
 * in or left those accounts.
 */
export async function getMonthCashflow(month: string, accountIds?: number[]) {
  if (accountIds && accountIds.length === 0) return { income: 0, expense: 0 }
  const { start, end } = monthRange(month)
  const [row] = await must<{ income: number; expense: number }[]>(
    (await db()).rpc("cashflow_between", {
      p_start: start,
      p_end: end,
      p_accounts: accountIds ?? null,
    })
  )
  return { income: Number(row?.income ?? 0), expense: Number(row?.expense ?? 0) }
}

/** Like getCategorySpend, for spending from these accounts only. */
export async function getCategorySpendFor(month: string, accountIds: number[]) {
  if (accountIds.length === 0) return []
  const { start, end } = monthRange(month)
  const rows = await must<
    { id: number | null; name: string | null; budget: number | null; spent: number }[]
  >(
    (await db()).rpc("category_spend_for", {
      p_start: start,
      p_end: end,
      p_accounts: accountIds,
    })
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "Uncategorized",
    budget: r.budget === null ? null : Number(r.budget),
    spent: Number(r.spent),
  }))
}

/** Everyone in the household, the owner first. */
export async function getPeople(): Promise<Person[]> {
  const rows = await must<
    { id: string; email: string; name: string | null; is_owner: boolean }[]
  >((await db()).rpc("household_people"))
  return rows.map((r) => ({
    id: r.id,
    name: r.name?.trim() || r.email.split("@")[0],
    isOwner: r.is_owner,
  }))
}

/** The signed-in person's name and the view they open on. */
export async function getMyPrefs(userId: string) {
  const [row] = await must<{ name: string | null; home_view: HomeView }[]>(
    (await db()).from("user_prefs").select("name, home_view").eq("user_id", userId)
  )
  return { name: row?.name ?? null, homeView: row?.home_view ?? "family" }
}

/** Whose each account is: account id to the holder's user id, or null for joint. */
export async function getAccountHolders() {
  const rows = await must<{ id: number; holder_id: string | null }[]>(
    (await db()).from("accounts").select("id, holder_id")
  )
  return new Map(rows.map((r) => [r.id, r.holder_id]))
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

export type StatementLine = {
  id: number | null
  name: string
  month: number
  window: number
}

/** Date range that averages are taken over: [start, end), plus its last day and length. */
export type AverageWindow = {
  start: string
  end: string
  last: string
  days: number
}

/**
 * The window that averages are taken over: up to `months` months ending with the latest
 * transaction, starting no earlier than the first one. It doesn't depend on the month being
 * viewed, so averages stay put while browsing months.
 */
export const getAverageWindow = cache(async function getAverageWindow(
  months = 12
): Promise<AverageWindow | null> {
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
})

/**
 * Income statement lines for a month, plus totals over the averaging window.
 * Amounts are net per category (refunds reduce spend). Transfers are excluded;
 * uncategorized money in/out is reported as its own income/expense line.
 */
export async function getIncomeStatement(
  month: string,
  window: AverageWindow | null
) {
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
  const byMonth = (a: StatementLine, b: StatementLine) =>
    b.month - a.month || b.window - a.window
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
export async function getBalancesAsOf(
  month: string,
  window: AverageWindow | null
) {
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
  >(
    (await db()).rpc("balances_as_of", {
      p_end: end,
      p_wstart: w.start,
      p_wend: w.end,
    })
  )
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
          d.rpc("recurring_transactions", {
            p_start: window.start,
            p_end: window.end,
          })
        )
      : [],
    must<RecurringOverrideRow[]>(
      d.from("recurring_overrides").select(COLUMNS.recurringOverrides)
    ),
    must<CategoryProjectionRow[]>(
      d.from("category_projections").select(COLUMNS.categoryProjections)
    ),
  ])
  return {
    txs: txs.map((r): RecurringTx => ({ ...r, amount: Number(r.amount) })),
    overrides: overrides.map((o): RecurringOverride => ({
      key: o.key,
      basis: o.basis,
      growthRate: o.growthRate,
      amount: o.amount,
      excluded: o.excluded,
    })),
    projections: projections.map((p): CategoryProjection => ({
      categoryId: p.categoryId,
      basis: p.basis,
      growthRate: p.growthRate,
      amount: p.amount,
    })),
  }
}

/** Every transaction in the averaging window, transfers included. */
export async function getWindowTransactions(window: AverageWindow) {
  const rows = await must<WindowTx[]>(
    (await db()).rpc("plan_transactions", {
      p_start: window.start,
      p_end: window.end,
    })
  )
  return rows.map((r): WindowTx => ({ ...r, amount: Number(r.amount) }))
}

/** One-off expenses from today on, soonest first. */
/**
 * Every one-off payment with the transactions linked to it, and the transactions in their
 * accounts since the earliest start that no one-off has yet, to link.
 */
export async function getOneOffs() {
  const client = await db()
  const [rows, links] = await Promise.all([
    must<OneOff[]>(
      client.from("one_offs").select(COLUMNS.oneOffs).order("finish_date").order("id")
    ),
    selectAll<{ oneOffId: number; tx: LinkedTx }>((from, to) =>
      client
        .from("one_off_transactions")
        .select("oneOffId:one_off_id, tx:transactions(id, date, description, amount)")
        .order("transaction_id")
        .range(from, to)
    ),
  ])
  const oneOffs = rows.map((o) => ({
    ...o,
    total: Number(o.total),
    setAside: Number(o.setAside),
    linked: links
      .filter((l) => l.oneOffId === o.id)
      .map((l) => ({ ...l.tx, amount: Number(l.tx.amount) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id),
  }))
  if (oneOffs.length === 0) return { oneOffs, unlinked: [] }

  const linkedIds = new Set(links.map((l) => l.tx.id))
  const since = oneOffs.reduce((min, o) => (o.startDate < min ? o.startDate : min), oneOffs[0].startDate)
  const candidates = await must<(LinkedTx & { accountId: number })[]>(
    client
      .from("transactions")
      .select("id, accountId:account_id, date, description, amount")
      .in("account_id", [...new Set(oneOffs.map((o) => o.accountId))])
      .gte("date", since)
      .order("date", { ascending: false })
      .order("id", { ascending: false })
      .limit(500)
  )
  const unlinked = candidates
    .filter((t) => !linkedIds.has(t.id))
    .map((t) => ({ ...t, amount: Number(t.amount) }))
  return { oneOffs, unlinked }
}

// ── Overview views ──────────────────────────────────────────────────────────

/** Like getCategorySpendBetween, for spending from these accounts only, over [start, end). */
export async function getCategorySpendForBetween(start: string, end: string, accountIds: number[]) {
  if (accountIds.length === 0) return []
  const rows = await must<
    { id: number | null; name: string | null; budget: number | null; spent: number }[]
  >(
    (await db()).rpc("category_spend_for", {
      p_start: start,
      p_end: end,
      p_accounts: accountIds,
    })
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "Uncategorized",
    budget: r.budget === null ? null : Number(r.budget),
    spent: Number(r.spent),
  }))
}

/** Cas's unresolved notes, newest first: observations, to-dos, decisions and preferences. */
export async function getOpenCasNotes(limit = 20) {
  return must<import("@/lib/db/schema").CasNote[]>(
    (await db())
      .from("cas_notes")
      .select(COLUMNS.casNotes)
      .is("resolved_at", null)
      .order("id", { ascending: false })
      .limit(limit)
  )
}

// ── Budget inputs ───────────────────────────────────────────────────────────

/** How many rows a query matches, without fetching them. */
async function countOf(query: PromiseLike<{ count: number | null; error: PostgrestError | null }>) {
  const { count, error } = await query
  if (error) throw new DbError(error)
  return count ?? 0
}

/**
 * What the Budget page is built from, read from the database only (no call to Akahu):
 * the bank syncs, what's left uncategorized, and the setup pages that feed it.
 */
export async function getBudgetInputs() {
  const client = await db()
  const [accounts, linked, uncategorized, rules, oneOffs, syncs] = await Promise.all([
    countOf(client.from("accounts").select("id", { count: "exact", head: true }).eq("archived", false)),
    countOf(
      client
        .from("accounts")
        .select("id", { count: "exact", head: true })
        .eq("archived", false)
        .not("akahu_id", "is", null)
    ),
    countOf(client.from("transactions").select("id", { count: "exact", head: true }).is("category_id", null)),
    countOf(client.from("rules").select("id", { count: "exact", head: true })),
    countOf(client.from("one_offs").select("id", { count: "exact", head: true })),
    must<{ accountId: number; finishedAt: string | null; error: string | null }[]>(
      client
        .from("akahu_syncs")
        .select("accountId:account_id, finishedAt:finished_at, error")
        .order("id", { ascending: false })
        .limit(200)
    ),
  ])
  // each account's latest sync decides whether it's failing
  const latest = new Map<number, (typeof syncs)[number]>()
  for (const s of syncs) if (!latest.has(s.accountId)) latest.set(s.accountId, s)
  const lastSyncedAt =
    syncs.find((s) => s.finishedAt !== null && s.error === null)?.finishedAt ?? null
  const failing = [...latest.values()].filter((s) => s.error !== null).length
  return { accounts, linked, uncategorized, rules, oneOffs, lastSyncedAt, failing }
}

export type BudgetInputs = Awaited<ReturnType<typeof getBudgetInputs>>

// ── Home's month ────────────────────────────────────────────────────────────

export type SpendTx = {
  id: number
  date: string
  description: string
  amount: number
  accountId: number
  categoryId: number | null
  categorySource: CategorySource | null
  /** the one-off payment it counts towards, if any */
  oneOffId: number | null
}

/** Every transaction counted as money in or out over [start, end), newest first: transfers and sinking-fund draws left out. */
export async function getSpendTransactions(start: string, end: string): Promise<SpendTx[]> {
  const client = await db()
  const rows = await selectAll<{
    id: number
    date: string
    description: string
    amount: number
    account_id: number
    category_id: number | null
    category_source: CategorySource | null
    one_off_id: number | null
  }>((from, to) => client.rpc("spend_transactions", { p_start: start, p_end: end }).range(from, to))
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    description: r.description,
    amount: Number(r.amount),
    accountId: r.account_id,
    categoryId: r.category_id,
    categorySource: r.category_source,
    oneOffId: r.one_off_id,
  }))
}
