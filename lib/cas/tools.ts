import "server-only"

import { differenceInHours, format, parseISO } from "date-fns"
import { z } from "zod"

import {
  categorizeMerchant,
  checkIn,
  deleteAsset,
  reconcileAccount,
  runAutoCategorize,
  saveAsset,
  saveUpcomingExpense,
  setCategoryBudgets,
  setTransactionCategory,
  syncAkahu,
  type ActionResult,
} from "@/app/actions"
import { getAkahuOverview, type AkahuOverview } from "@/lib/akahu"
import { healthReasons, planTools } from "@/lib/cas/plan-tools"
import { tool, isoDate, type CasTool } from "@/lib/cas/tool"
import { loadDataHealth } from "@/lib/data-health"
import { buildStats } from "@/lib/checkin"
import { COLUMNS, getDb, must } from "@/lib/db"
import { ASSET_KINDS, NOTE_KINDS, type CasNote } from "@/lib/db/schema"
import { buildNetWorth } from "@/lib/net-worth"
import { describeSimulation, simulate } from "@/lib/plan"
import { planStatus } from "@/lib/plan-service"
import { planDeps } from "@/lib/plan-repo"
import { latestPlan, loadSnapshot } from "@/lib/planner"
import {
  getAccountsWithBalances,
  getAssets,
  getAverageWindow,
  getCategoriesWithUsage,
  getCategorizationStats,
  getCategorySpend,
  getCheckIns,
  getIncomeStatement,
  getLatestMonth,
  getMonthlyCashflow,
  getPlanThread,
  getRuleReview,
  getSettings,
  getStatements,
  getTransactions,
  getUncategorizedMerchants,
  getUpcomingExpenses,
  PAGE_SIZE,
} from "@/lib/queries"

export type { CasTool }

// Every tool over your finances, defined once. Cascadale's MCP server (lib/mcp.ts) offers the
// read and action tools to clients such as claude.ai; the Cas agent (lib/cas/agent.ts)
// gets the read and memory tools, so it never changes your finances itself. Changes go
// through the MCP client, which asks you first.

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, "Use yyyy-MM")
const month = yearMonth
  .optional()
  .describe("Month as yyyy-MM. Defaults to the month of the latest transaction.")

/** Hours after which a linked account that hasn't synced is worth mentioning (it runs hourly). */
const STALE_HOURS = 26
const today = () => format(new Date(), "yyyy-MM-dd")

/** The month asked for, or the latest month with transactions. */
async function monthOrLatest(m?: string) {
  const latest = m ?? (await getLatestMonth())
  if (!latest) throw new Error("There are no transactions yet.")
  return latest
}

/** Unwrap a server action's result, so a failure reaches the caller as a tool error. */
async function act<T extends object>(result: Promise<ActionResult<T>>) {
  const res = await result
  if (!res.ok) throw new Error(res.error)
  return res
}

/** Bank feed health: each Akahu account, where it syncs, and whether that's working. */
async function syncStatus(overview?: AkahuOverview) {
  overview ??= await getAkahuOverview()
  if (!overview.connected) return { connected: false as const }
  const now = new Date()
  const accounts = overview.accounts.map((a) => {
    const hoursSinceSync = a.lastSync ? differenceInHours(now, parseISO(a.lastSync.at)) : null
    const linked = a.linkedTo !== null
    return {
      ...a,
      hoursSinceSync,
      problem: !a.active
        ? "Akahu has lost access to this account; reconnect it at my.akahu.nz"
        : a.lastSync?.error
          ? `The last sync failed: ${a.lastSync.error}`
          : linked && (hoursSinceSync === null || hoursSinceSync > STALE_HOURS)
            ? "Hasn't synced in over a day"
            : !linked && !a.ignored
              ? "Not linked yet; the next sync will add an account for it"
              : null,
    }
  })
  const recentFailures = await must<
    { accountId: number; startedAt: string; runBy: string; error: string }[]
  >(
    (await getDb())
      .from("akahu_syncs")
      .select("accountId:account_id, startedAt:started_at, runBy:run_by, error")
      .not("error", "is", null)
      .order("id", { ascending: false })
      .limit(10)
  )
  return { connected: true as const, error: overview.error, accounts, recentFailures }
}

async function notes(includeResolved = false) {
  let query = (await getDb())
    .from("cas_notes")
    .select(COLUMNS.casNotes)
    .order("id", { ascending: false })
    .limit(100)
  if (!includeResolved) query = query.is("resolved_at", null)
  return must<CasNote[]>(query)
}

/** The plan tools act as Claude (MCP); the Cas agent only gets their read tools. */
const PLAN_TOOLS = planTools({ deps: () => planDeps("mcp"), health: () => loadDataHealth() })

export const TOOLS: CasTool[] = [
  tool({
    name: "get_briefing",
    title: "Briefing",
    access: "read",
    description:
      "Start here. Everything happening right now in one call: bank feed health, what came in and went out since the last check-in against the usual pattern, the projected low point of your balances over the next 60 days, upcoming bills and one-offs, what needs categorizing, the last check-in's verdict, whether the plan is current, and Cas's open notes and to-dos. Includes data_health: check it before relying on the numbers.",
    run: async () => {
      const snap = await loadSnapshot()
      const overview = await getAkahuOverview().catch(
        (err: Error): AkahuOverview => ({ connected: true, error: err.message, accounts: [] })
      )
      const [sync, sinceLastCheckIn, categorization, merchants, lowRules, [last], open, health] =
        await Promise.all([
          syncStatus(overview).catch((err: Error) => ({ error: err.message })),
          snap ? buildStats(snap) : null,
          getCategorizationStats(),
          getUncategorizedMerchants(),
          getRuleReview("low"),
          getCheckIns(1),
          notes(),
          loadDataHealth(overview),
        ])
      const plan = await planStatus(await planDeps("mcp"), undefined, healthReasons(health))
      return {
        today: today(),
        sync,
        sinceLastCheckIn,
        categorization: {
          ...categorization,
          topUncategorizedMerchants: merchants.slice(0, 10),
          lowConfidenceRules: lowRules.length,
        },
        lastCheckIn: last
          ? {
              date: last.createdAt.slice(0, 10),
              status: last.result.status,
              headline: last.result.headline,
              actions: last.result.actions,
            }
          : null,
        plan: { status: plan.status, reasons: plan.reasons },
        openNotes: open,
        data_health: health,
      }
    },
  }),

  tool({
    name: "get_overview",
    title: "Accounts",
    access: "read",
    description:
      "The currency and every account with its current balance (credit cards and loans negative when owed), the latest month with transactions. Each account also has its pending transactions (authorised by the bank, not posted yet, flagged pending) and balanceWithPending, so a payment made minutes ago shows; a pending one drops out once it posts, so nothing counts twice. Amounts are signed: negative is money out. Includes data_health (stale feeds, drift from the bank's balance).",
    run: async () => {
      const [settings, accounts, latestMonth, health] = await Promise.all([
        getSettings(),
        getAccountsWithBalances(),
        getLatestMonth(),
        loadDataHealth(),
      ])
      const byId = new Map(health.accounts.map((a) => [a.accountId, a]))
      return {
        ...settings,
        latestMonth,
        accounts: accounts.map((a) => ({
          ...a,
          pending: health.pendingTransactions.filter((p) => p.accountId === a.id),
          balanceWithPending: byId.get(a.id)?.balanceWithPending ?? a.balance,
          bankBalance: byId.get(a.id)?.bankBalance ?? null,
        })),
        data_health: health,
      }
    },
  }),

  tool({
    name: "get_net_worth",
    title: "Net worth",
    access: "read",
    description:
      "Net worth: what you own less what you owe. Adds account balances to the assets valued by hand (such as the house), with each asset's id, value and the date it was valued, and lists accounts as cash, investments and debts. An overdrawn account counts as a debt. Asset values are only as current as valuedOn.",
    run: async () => {
      const [accounts, assets] = await Promise.all([getAccountsWithBalances(), getAssets()])
      const account = ({ id, name, type, institution, balance }: (typeof accounts)[number]) => ({
        id,
        name,
        type,
        institution,
        balance,
      })
      const worth = buildNetWorth(accounts, assets)
      return {
        netWorth: worth.netWorth,
        owned: worth.owned,
        owed: worth.totals.debts,
        totals: worth.totals,
        assets: worth.assets,
        investments: worth.investments.map(account),
        cash: worth.cash.map(account),
        debts: worth.debts.map(account),
      }
    },
  }),

  tool({
    name: "get_sync_status",
    title: "Bank feed status",
    access: "read",
    description:
      "Each Akahu bank feed account: which account of yours it syncs into, when it last synced and how many transactions it added, Akahu's own refresh time, any problem, and the latest failed sync runs. Syncs run hourly.",
    run: () => syncStatus(),
  }),

  tool({
    name: "get_financial_picture",
    title: "Financial picture",
    access: "read",
    description:
      "How your money normally flows, as the planner sees it: balances, recurring incomes and bills with their cadence and next dates, typical day-to-day spending and irregular income per category, budgets against projections, and upcoming one-offs. Plus a 90-day cash simulation under your current plan (pots, overdrafts, bills no pot covers).",
    run: async () => {
      const snap = await loadSnapshot()
      if (!snap) return { error: "Import some transactions first." }
      const thread = await getPlanThread()
      const plan = thread ? latestPlan(thread.messages) : null
      return { snapshot: snap, simulation: describeSimulation(snap, simulate(snap, plan)) }
    },
  }),

  ...PLAN_TOOLS.filter((t) => t.access === "read"),

  tool({
    name: "list_categories",
    title: "Categories",
    access: "read",
    description:
      "Every category with its kind (expense, income or transfer), monthly budget and number of transactions. Use the ids to filter or recategorize transactions.",
    run: getCategoriesWithUsage,
  }),

  tool({
    name: "search_transactions",
    title: "Search transactions",
    access: "read",
    description: `Transactions newest first, ${PAGE_SIZE} per page, with the total count and money in/out across every match. Amounts are signed: negative is money out.`,
    input: {
      accountId: z.number().int().positive().optional(),
      categoryId: z.number().int().positive().optional(),
      uncategorized: z.boolean().optional().describe("Only transactions with no category"),
      month: yearMonth.optional().describe("Only this month, as yyyy-MM"),
      query: z.string().optional().describe("Text the description contains"),
      page: z.number().int().positive().optional(),
    },
    run: ({ accountId, categoryId, uncategorized, month, query, page }) =>
      getTransactions({
        account: accountId,
        category: uncategorized ? "none" : categoryId,
        month,
        q: query,
        page,
      }),
  }),

  tool({
    name: "monthly_cashflow",
    title: "Monthly cash flow",
    access: "read",
    description:
      "Income, spending and net per month. Transfers are excluded; uncategorized money in/out counts as income/spending.",
    input: {
      endMonth: month,
      months: z.number().int().min(1).max(60).optional().describe("How many months (default 12)"),
    },
    run: async ({ endMonth, months }) =>
      getMonthlyCashflow(await monthOrLatest(endMonth), months),
  }),

  tool({
    name: "category_spending",
    title: "Spending by category",
    access: "read",
    description:
      "Net spending per expense category for a month (refunds reduce spend), with each category's monthly budget.",
    input: { month },
    run: async (args) => {
      const m = await monthOrLatest(args.month)
      return { month: m, categories: await getCategorySpend(m) }
    },
  }),

  tool({
    name: "income_statement",
    title: "Income statement",
    access: "read",
    description:
      "Income and expense lines per category for a month, as positive amounts, plus each line's total over the averaging window (up to 12 months ending with the latest transaction).",
    input: { month },
    run: async (args) => {
      const m = await monthOrLatest(args.month)
      const window = await getAverageWindow()
      return { month: m, window, ...(await getIncomeStatement(m, window)) }
    },
  }),

  tool({
    name: "get_review_queue",
    title: "Review queue",
    access: "read",
    description:
      "What needs categorizing: uncategorized transactions grouped by merchant key (biggest groups first), and auto-categorized rules with low confidence that are worth checking.",
    run: async () => {
      const [merchants, lowRules, stats] = await Promise.all([
        getUncategorizedMerchants(),
        getRuleReview("low"),
        getCategorizationStats(),
      ])
      return { stats, uncategorizedMerchants: merchants.slice(0, 50), lowConfidenceRules: lowRules.slice(0, 50) }
    },
  }),

  tool({
    name: "upcoming_expenses",
    title: "Upcoming expenses",
    access: "read",
    description: "One-off expenses planned from today on, soonest first.",
    run: getUpcomingExpenses,
  }),

  tool({
    name: "get_check_ins",
    title: "Check-ins",
    access: "read",
    description:
      "Past check-ins, newest first: the period each covered, its status (on_track, watch, off_track), headline, advice and actions.",
    input: { limit: z.number().int().min(1).max(20).optional().describe("Default 5") },
    run: async ({ limit }) =>
      (await getCheckIns(limit ?? 5)).map((c) => ({
        date: c.createdAt.slice(0, 10),
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
        ...c.result,
      })),
  }),

  tool({
    name: "list_imports",
    title: "Statement imports",
    access: "read",
    description: "Statement files imported by hand, newest first, with the account and dates each covered.",
    run: getStatements,
  }),

  // ── Cas's memory ──

  tool({
    name: "read_notes",
    title: "Cas notes",
    access: "memory",
    description:
      "Cas's notes: observations, your decisions and preferences, and open to-dos. Open ones only unless includeResolved.",
    input: { includeResolved: z.boolean().optional() },
    run: ({ includeResolved }) => notes(includeResolved),
  }),

  tool({
    name: "save_note",
    title: "Save a note",
    access: "memory",
    description:
      "Remember something for later conversations: an observation worth tracking, a decision or preference you stated, or a to-do (with a due date if it has one). One fact per note; don't save what the data already shows. Set affectsPlan on a decision that changes the plan (a pot, an amount, a skipped or extra payment): the plan then shows as out of date with it until a plan change carries it out.",
    input: {
      kind: z.enum(NOTE_KINDS),
      content: z.string().trim().min(1).max(1000),
      dueDate: isoDate.optional(),
      affectsPlan: z.boolean().optional().describe("Only for decisions that change the plan"),
    },
    run: async ({ kind, content, dueDate, affectsPlan }) =>
      must<CasNote>(
        (await getDb())
          .from("cas_notes")
          .insert({ kind, content, due_date: dueDate ?? null, affects_plan: kind === "decision" && !!affectsPlan })
          .select(COLUMNS.casNotes)
          .single()
      ),
  }),

  tool({
    name: "resolve_note",
    title: "Resolve a note",
    access: "memory",
    description: "Mark a to-do done, or a note as no longer true, with a short reason. It's kept as history.",
    input: { noteId: z.number().int().positive(), resolution: z.string().trim().min(1).max(500) },
    run: async ({ noteId, resolution }) => {
      const [note] = await must<CasNote[]>(
        (await getDb())
          .from("cas_notes")
          .update({ resolved_at: new Date().toISOString(), resolution })
          .eq("id", noteId)
          .select(COLUMNS.casNotes)
      )
      if (!note) throw new Error("Note not found")
      return note
    },
  }),

  // ── Actions: these change your data ──

  tool({
    name: "sync_bank_feeds",
    title: "Sync bank feeds now",
    access: "action",
    description:
      "Pull new transactions from Akahu into every linked account now (it also runs hourly), categorize them with your rules, then with AI. Returns how many were added and categorized.",
    run: () => act(syncAkahu()),
  }),

  tool({
    name: "set_transaction_category",
    title: "Recategorize a transaction",
    access: "action",
    description:
      "Set a transaction's category (or clear it with null). Like doing it in the app, this learns a rule for the merchant and recategorizes its other transactions.",
    input: {
      transactionId: z.number().int().positive(),
      categoryId: z.number().int().positive().nullable(),
    },
    run: ({ transactionId, categoryId }) => act(setTransactionCategory(transactionId, categoryId)),
  }),

  tool({
    name: "categorize_merchant",
    title: "Categorize a merchant",
    access: "action",
    description:
      "Categorize every uncategorized transaction of a merchant (its key from get_review_queue) and remember it as a rule.",
    input: { merchantKey: z.string().trim().min(1), categoryId: z.number().int().positive() },
    run: ({ merchantKey, categoryId }) => act(categorizeMerchant(merchantKey, categoryId)),
  }),

  tool({
    name: "auto_categorize",
    title: "Auto-categorize",
    access: "action",
    description:
      "Categorize every uncategorized transaction: your rules first, then AI for the rest (uses the Anthropic API key saved in Settings).",
    run: () => act(runAutoCategorize()),
  }),

  tool({
    name: "set_category_budgets",
    title: "Set budgets",
    access: "action",
    description: "Set the monthly budget of one or more expense categories.",
    input: {
      budgets: z
        .array(z.object({ categoryId: z.number().int().positive(), amount: z.number().nonnegative() }))
        .min(1),
    },
    run: ({ budgets }) => act(setCategoryBudgets(budgets)),
  }),

  tool({
    name: "reconcile_account",
    title: "Reconcile to bank balance",
    access: "action",
    description:
      "Make an account's balance match the bank's: sets its opening balance so the opening balance plus every transaction up to asOf (default: all of them) equals the given balance. Use when get_overview's balance has drifted from the bank. Returns the old and new opening balance; overwrittenBySync means the hourly Akahu sync already matches this account to the bank and will undo the change.",
    input: {
      accountId: z.number().int().positive(),
      balance: z.number().describe("The bank's balance, signed like get_overview (negative when owed)"),
      asOf: isoDate
        .optional()
        .describe("The day the bank's balance is from, if it's older than the latest transactions"),
    },
    run: ({ accountId, balance, asOf }) => act(reconcileAccount(accountId, balance, asOf)),
  }),

  tool({
    name: "upsert_asset",
    title: "Add or update an asset",
    access: "action",
    description:
      "Add something you own that no bank feed values, such as a house or a car, or update one by passing its assetId from get_net_worth. Its value counts towards net worth.",
    input: {
      assetId: z.number().int().positive().optional().describe("The asset to update; omit to add one"),
      name: z.string().trim().min(1),
      kind: z.enum(ASSET_KINDS),
      value: z.number().nonnegative().describe("What it's worth, as a positive amount"),
      valuedOn: isoDate.optional().describe("The date of that value. Defaults to today."),
      note: z.string().optional().describe("Where the value came from. Omit to keep the current note."),
    },
    run: ({ assetId, name, kind, value, valuedOn, note }) => {
      const form = new FormData()
      if (assetId) form.set("id", String(assetId))
      form.set("name", name)
      form.set("kind", kind)
      form.set("value", String(value))
      form.set("valuedOn", valuedOn ?? today())
      if (note !== undefined) form.set("note", note)
      return act(saveAsset(form))
    },
  }),

  tool({
    name: "remove_asset",
    title: "Remove an asset",
    access: "action",
    description: "Delete an asset by its assetId from get_net_worth, taking its value out of net worth.",
    input: { assetId: z.number().int().positive() },
    run: ({ assetId }) => act(deleteAsset(assetId)),
  }),

  tool({
    name: "add_upcoming_expense",
    title: "Add an upcoming expense",
    access: "action",
    description:
      "Tell the app about a one-off expense coming up, so plans, check-ins and the cash simulation account for it.",
    input: {
      name: z.string().trim().min(1),
      amount: z.number().positive().describe("What you expect to pay, as a positive amount"),
      dueDate: isoDate,
      accountId: z.number().int().positive().optional().describe("Account it'll be paid from"),
      note: z.string().optional(),
    },
    run: ({ name, amount, dueDate, accountId, note }) => {
      const form = new FormData()
      form.set("name", name)
      form.set("amount", String(amount))
      form.set("dueDate", dueDate)
      if (accountId) form.set("accountId", String(accountId))
      if (note) form.set("note", note)
      return act(saveUpcomingExpense(form))
    },
  }),

  tool({
    name: "run_check_in",
    title: "Run a check-in",
    access: "action",
    description:
      "Run a check-in like the one on the home page: analyse what was logged since the last one against the plan, save it, and return its status, with data_health (stale feeds or drift make the check-in less reliable). Uses the Anthropic API key saved in Settings.",
    run: async () => {
      // checked first, so a check-in on stale data says so
      const health = await loadDataHealth()
      return { ...(await act(checkIn())), data_health: health }
    },
  }),

  ...PLAN_TOOLS.filter((t) => t.access === "action"),
]
