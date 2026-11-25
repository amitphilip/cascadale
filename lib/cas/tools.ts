import "server-only"

import { addDays, differenceInHours, format, parseISO } from "date-fns"
import { z } from "zod"

import {
  categorizeMerchant,
  deleteAsset,
  linkOneOffTransactions,
  moveTransaction,
  reconcileAccount,
  runAutoCategorize,
  saveAsset,
  saveOneOff,
  setAccountInterestRate,
  setCategoryBudgets,
  setTransactionCategory,
  syncAkahu,
  unlinkOneOffTransaction,
  updateCas,
  type ActionResult,
} from "@/app/actions"
import { getAkahuOverview, type AkahuOverview } from "@/lib/akahu"
import { budgetPeriod, freshCategories } from "@/lib/budget-percent"
import { monthOf, trackBudgets, weekOf, type Range } from "@/lib/budget-tracking"
import { tool, isoDate, type CasTool } from "@/lib/cas/tool"
import { getCorrections } from "@/lib/cas-queue"
import { loadDataHealth } from "@/lib/data-health"
import { COLUMNS, getDb, getUserId, must } from "@/lib/db"
import {
  ASSET_KINDS,
  BUDGET_PERIODS,
  NOTE_KINDS,
  ONE_OFF_FREQUENCIES,
  ONE_OFF_OUT_MODES,
  type CasNote,
  type OneOff,
} from "@/lib/db/schema"
import { makePlan } from "@/lib/cas/plan"
import { currentShortTerm, refreshShortTerm, setShortTerm } from "@/lib/cas/short-term"
import { expectedFrom } from "@/lib/income"
import { getInbox } from "@/lib/inbox"
import { loadMonthFigures } from "@/lib/month"
import { buildNetWorth } from "@/lib/net-worth"
import { planOneOff } from "@/lib/one-offs"
import { oneOffFigure } from "@/lib/plan-figures"
import { getCurrentPlan } from "@/lib/plan-data"
import { loadPlanInputs } from "@/lib/plan-inputs"
import {
  getAccountHolders,
  getAccountsWithBalances,
  getAssets,
  getAverageWindow,
  getCategoriesWithUsage,
  getCategorizationStats,
  getCategorySpend,
  getCategorySpendBetween,
  getCategorySpendFor,
  getIncomeStatement,
  getLatestMonth,
  getMonthCashflow,
  getMonthlyCashflow,
  getMyPrefs,
  getOneOffs,
  getPeople,
  getRuleReview,
  getSettings,
  getStatements,
  getTransactions,
  getUncategorizedMerchants,
  PAGE_SIZE,
} from "@/lib/queries"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

export type { CasTool }

// Every tool over your finances, defined once. Cascadale's MCP server (lib/mcp.ts) offers the
// read and action tools to clients such as claude.ai; the Cas agent (lib/cas/agent.ts)
// gets the read and memory tools, so it never changes your finances itself: changes go
// through the MCP client, which asks you first.

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, "Use yyyy-MM")
const month = yearMonth
  .optional()
  .describe("Month as yyyy-MM. Defaults to the month of the latest transaction.")

/** Hours after which a linked account that hasn't synced is worth mentioning (it runs hourly). */
const STALE_HOURS = 26
/** Failed sync runs older than this aren't listed. */
const FAILURE_DAYS = 7

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
      // older failures have been fixed or superseded; the latest sync per account is in lastSync
      .gte("started_at", addDays(now, -FAILURE_DAYS).toISOString())
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

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Whose each account is, as on Home's My and Family views: the signed-in person,
 * the household's people, each account's holder by name (null for joint), and your accounts.
 */
async function household() {
  const userId = await getUserId()
  const [people, holders, prefs] = await Promise.all([getPeople(), getAccountHolders(), getMyPrefs(userId)])
  const nameOf = new Map(people.map((p) => [p.id, p.name]))
  const you = prefs.name ?? nameOf.get(userId) ?? "Me"
  nameOf.set(userId, you)
  return {
    you,
    people: people.map((p) => (p.id === userId ? { ...p, name: you, isYou: true } : { ...p, isYou: false })),
    holderOf: (accountId: number) => {
      const h = holders.get(accountId) ?? null
      return h === null ? null : (nameOf.get(h) ?? null)
    },
    mine: [...holders].filter(([, h]) => h === userId).map(([id]) => id),
  }
}

const whose = z
  .enum(["everyone", "mine"])
  .optional()
  .describe('"mine" counts only the accounts marked as yours (Home\'s My view); default "everyone" (the Family view)')

/** What the one-off fields mean, for the tools that return them. */
const ONE_OFF_FIELDS =
  "total is the whole amount to pay; paidIn is what's gone into its account for it (setAside, what was already there when it was added, plus linked money in); paidOut is linked money paid out; held = paidIn − paidOut, what's in the account for it now; remaining = total − paidOut, still to pay (held doesn't reduce it: held money is paid out of it later); toPutIn is what still has to go in by the plan; monthlyNeed is toPutIn spread over the months to its last contribution; needNow is what's needed before the next scheduled contribution to make a payment; status is on_track, catch_up (money needed now), overdue (finish date passed with some left) or paid. Only transactions linked to it count, and only ones in its own account."

/**
 * Every one-off payment with where it stands and what it needs, from the transactions linked
 * to it. `detail` adds the planned moves, the linked transactions and the ones in its
 * account that could be linked.
 */
async function oneOffPayments(detail: boolean) {
  const today = todayLocal()
  const [{ oneOffs, unlinked }, accounts] = await Promise.all([getOneOffs(), getAccountsWithBalances()])
  const account = new Map(accounts.map((a) => [a.id, a]))
  return oneOffs.map((o) => {
    const plan = planOneOff(o, o.linked, today)
    const figure = oneOffFigure(o, plan, today)
    return {
      oneOffId: o.id,
      name: o.name,
      account: account.get(o.accountId)?.name ?? null,
      accountId: o.accountId,
      accountBalance: account.get(o.accountId)?.balance ?? null,
      total: o.total,
      startDate: o.startDate,
      finishDate: o.finishDate,
      paidOutHow: o.outMode === "spread" ? `in parts every ${o.outEvery}, the last on finishDate` : "in one go on finishDate",
      putInEvery: o.inEvery,
      setAside: o.setAside,
      note: o.note,
      status: plan.status,
      paidIn: plan.paidIn,
      paidOut: plan.paidOut,
      held: plan.held,
      remaining: plan.remaining,
      surplus: plan.surplus,
      toPutIn: plan.toPutIn,
      monthlyNeed: figure.monthly,
      needNow: figure.needNow,
      nextMoves: plan.moves.slice(0, detail ? 12 : 3),
      ...(detail && {
        linkedTransactions: o.linked,
        linkable: unlinked
          .filter((t) => t.accountId === o.accountId && t.date >= o.startDate)
          .slice(0, 30)
          .map(({ id, date, description, amount }) => ({ id, date, description, amount })),
      }),
    }
  })
}

const lastDay = (r: Range) => format(addDays(parseISO(r.end), -1), "yyyy-MM-dd")

/**
 * Each budget against its own period, this week (Monday to Sunday) or this calendar month,
 * with percentage budgets first brought in step with projected income.
 */
async function budgetProgress() {
  const today = todayLocal()
  const week = weekOf(today)
  const month = monthOf(today)
  const [{ categories, income }, monthSpend, weekSpend] = await Promise.all([
    freshCategories(),
    getCategorySpendBetween(month.start, month.end),
    getCategorySpendBetween(week.start, week.end),
  ])
  const byId = (rows: { id: number | null; spent: number }[]) =>
    new Map(rows.flatMap((r) => (r.id === null ? [] : [[r.id, r.spent] as const])))
  const budgets = trackBudgets(categories, { month: byId(monthSpend), week: byId(weekSpend) }, today)
  const budgeted = new Set(budgets.map((b) => b.id))
  return {
    today,
    week: { from: week.start, to: lastDay(week) },
    month: { from: month.start, to: lastDay(month) },
    projectedMonthlyIncome: income === null ? null : round2(income),
    budgets: budgets.map((b) => ({
      categoryId: b.id,
      name: b.name,
      period: b.period,
      budget: round2(b.budget),
      percentOfIncome: b.percent,
      spent: round2(b.spent),
      left: round2(b.left),
      expectedByNow: round2(b.expected),
      pace: b.pace,
    })),
    unbudgetedThisMonth: monthSpend
      .filter((r) => r.spent > 0 && (r.id === null || !budgeted.has(r.id)))
      .map((r) => ({ categoryId: r.id, name: r.name, spent: round2(r.spent) })),
  }
}

export const TOOLS: CasTool[] = [
  tool({
    name: "get_briefing",
    title: "Briefing",
    access: "read",
    description:
      "Start here. Everything happening right now in one call: bank feed health, this month's money in and out so far, the regular pays still due before the month ends (thisMonth.incomeStillDue, each due, late or missed; incomeByMonthEnd is what's in so far plus the due and late ones), projected monthly income, each budget against its own period (this week for a weekly one, this month for a monthly one), the one-off payments still to pay, what needs categorizing, Cas's open notes and to-dos, homeMonth (the household's month exactly as Home shows it: in so far and expected by month end, out so far, planned and projected, the net, and left to spend), and corrections (transactions the household moved on Home: those waiting for Cas and those recently taken in). thisMonth is the whole household (the Family view); thisMonth.yours is only the accounts marked as yours (the My view), and you names who's asking. Includes data_health: check it before relying on the numbers.",
    run: async () => {
      const overview = await getAkahuOverview().catch(
        (err: Error): AkahuOverview => ({ connected: true, error: err.message, accounts: [] })
      )
      const thisMonth = todayLocal().slice(0, 7)
      const people = await household()
      const [sync, cashflow, yours, budgets, oneOffs, categorization, merchants, lowRules, open, health, inputs] =
        await Promise.all([
          syncStatus(overview).catch((err: Error) => ({ error: err.message })),
          getMonthCashflow(thisMonth),
          getMonthCashflow(thisMonth, people.mine),
          budgetProgress(),
          oneOffPayments(false),
          getCategorizationStats(),
          getUncategorizedMerchants(),
          getRuleReview("low"),
          notes(),
          loadDataHealth(overview),
          loadPlanInputs(),
        ])
      const [corrections, home] = await Promise.all([
        getCorrections(),
        loadMonthFigures({ inputs }),
      ])
      // The month so far is only part of it: add the pays still due before it ends.
      const due = inputs?.paysDue ?? []
      const mine = new Set(people.mine)
      const stillToCome = (pays: typeof due, received: number) => {
        const expected = expectedFrom(pays)
        return { incomeStillDue: pays, incomeByMonthEnd: round2(received + expected), stillExpected: expected }
      }
      return {
        today: todayLocal(),
        you: people.you,
        sync,
        thisMonth: {
          month: thisMonth,
          ...cashflow,
          ...stillToCome(due, cashflow.income),
          yours: {
            accounts: people.mine.length,
            ...yours,
            ...stillToCome(due.filter((p) => mine.has(p.accountId)), yours.income),
          },
        },
        homeMonth: {
          inSoFar: home.in.soFar,
          inExpected: home.in.expected,
          outSoFar: home.out.soFar,
          outPlanned: home.out.planned,
          outProjected: home.out.projected,
          outProjectedLessPlanned: home.out.diff,
          netByMonthEnd: home.net,
          leftToSpend: home.leftToSpend,
        },
        corrections: {
          waiting: corrections.waiting.length,
          waitingMoves: corrections.waiting,
          recentlyTakenIn: corrections.recentlyTakenIn.slice(0, 20),
        },
        projectedMonthlyIncome: budgets.projectedMonthlyIncome,
        budgets: {
          week: budgets.week,
          budgets: budgets.budgets,
          unbudgetedThisMonth: budgets.unbudgetedThisMonth,
        },
        oneOffPayments: oneOffs.filter((o) => o.status !== "paid"),
        categorization: {
          ...categorization,
          topUncategorizedMerchants: merchants.slice(0, 10),
          lowConfidenceRules: lowRules.length,
        },
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
      "The currency and every account with its current balance (credit cards and loans negative when owed), the latest month with transactions, and the household's people. Each account has holder, whose it is by name (null for joint), as on Home's My and Family views; you names who's asking. Each account also has its pending transactions (authorised by the bank, not posted yet, flagged pending) and balanceWithPending, so a payment made minutes ago shows; a pending one drops out once it posts, so nothing counts twice. Amounts are signed: negative is money out. Includes data_health (stale feeds, drift from the bank's balance).",
    run: async () => {
      const [settings, accounts, latestMonth, health, people] = await Promise.all([
        getSettings(),
        getAccountsWithBalances(),
        getLatestMonth(),
        loadDataHealth(),
        household(),
      ])
      const byId = new Map(health.accounts.map((a) => [a.accountId, a]))
      return {
        ...settings,
        latestMonth,
        you: people.you,
        people: people.people,
        accounts: accounts.map((a) => ({
          ...a,
          holder: people.holderOf(a.id),
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
      const account = ({ id, name, type, institution, balance, interestRate }: (typeof accounts)[number]) => ({
        id,
        name,
        type,
        institution,
        balance,
        interestRate,
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
    name: "get_inbox",
    title: "Inbox",
    access: "read",
    description:
      "What Home's inbox shows the household right now, most urgent first: the messages Cas sent on its own (source nudge: a pay landed and what to move, the Monday check-in), the plan's open to-do actions (source plan) and Cas's open to-dos (source cas). Each has a key, title, detail and due date.",
    run: () => getInbox(),
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
    name: "list_categories",
    title: "Categories",
    access: "read",
    description:
      "Every category with its kind (expense, income or transfer), budget and number of transactions. budgetPeriod is week (Monday to Sunday) or month; weeklyBudget is a weekly budget's own amount and monthlyBudget is always the monthly figure (a weekly one's monthly equivalent). budgetPercent is set when the budget is a percent of projected monthly income; its amounts are what that comes to today. Use the ids to filter or recategorize transactions.",
    run: async () => {
      await freshCategories()
      const categories = await getCategoriesWithUsage()
      return categories.map((c) => ({
        ...c,
        budgetPeriod: c.monthlyBudget === null ? null : budgetPeriod(c),
      }))
    },
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
      "Net spending per expense category for a calendar month (refunds reduce spend), with each category's monthly budget (a weekly one's monthly equivalent). For this week and this month against each budget's own period, use budget_progress. With whose \"mine\" it counts only your accounts; budgets are the household's either way.",
    input: { month, whose },
    run: async (args) => {
      const [m] = await Promise.all([monthOrLatest(args.month), freshCategories()])
      if (args.whose !== "mine") return { month: m, whose: "everyone", categories: await getCategorySpend(m) }
      const { mine } = await household()
      return { month: m, whose: "mine", accounts: mine.length, categories: await getCategorySpendFor(m, mine) }
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
    name: "budget_progress",
    title: "Budget progress",
    access: "read",
    description:
      "Each budget against its own period: a weekly one this week (Monday to Sunday), a monthly one this calendar month. budget is the amount for that period, spent is net of refunds, expectedByNow is what an even pace allows so far, pace is over (spent more than the budget), ahead (more than 10% over the even pace) or on_pace. percentOfIncome is set when the budget is a percent of projected monthly income. Also projected monthly income and this month's spending in categories with no budget.",
    run: budgetProgress,
  }),

  tool({
    name: "one_off_payments",
    title: "One-off payments",
    access: "read",
    description: `Every one-off payment, the known costs coming up (a trip, rates, a medical fee): a total gathered in an account and paid out by a finish date, in one go or in parts. Each has where it stands, what it still needs, the next planned moves (money in, payments out), the transactions linked to it, and linkable: transactions in its account since it started that no one-off counts yet. ${ONE_OFF_FIELDS}`,
    run: () => oneOffPayments(true),
  }),

  tool({
    name: "get_plan",
    title: "Plan",
    access: "read",
    description:
      "The household's plan, as the Plan page shows it: Cas's verdict on whether it's realistic (realistic, stretch, unrealistic) with the reason and each goal weighed, where each pay goes (allocations, each with an amount per week, fortnight, month or once, and the budget category or one-off it's for), and the to-do actions (doneAt set when ticked off). Also today's figures it stands on: projected income, bills and budgets, one-off needs, what's left over, and budgets set well below how a category runs. today.figures are monthly: income (projected), committed (each category's budget, else its projection), projectedSpend (what spending runs at), oneOffs (the one-offs' monthly need), leftOver (income − committed − oneOffs) and leftOverAsProjected (the same with spending as it runs). today.categories has each budget's period and percent of income; today.oneOffs has each one-off payment's figures (see one_off_payments for what they mean). today.paysDue lists the regular pays still due this month. plan is null before Cas has made one.",
    run: async () => {
      const [current, inputs] = await Promise.all([getCurrentPlan(), loadPlanInputs()])
      return {
        plan: current && {
          ...current.plan,
          allocations: current.allocations,
          actions: current.actions,
        },
        today: inputs && {
          figures: inputs.figures,
          categories: inputs.categories,
          oneOffs: inputs.oneOffs,
          incomeSources: inputs.incomeSources,
          paysDue: inputs.paysDue,
        },
      }
    },
  }),

  tool({
    name: "get_short_term",
    title: "This pay's moves",
    access: "read",
    description:
      "The signed-in person's short-term allocation: the transfers for their pay this pay cycle (payday to the next), which Cas works out from the plan (the long-term allocation) and what has happened since payday, and looks at again whenever a sync brings in a pay or a move. lines are Cas's: one with a planItemId sets that plan move's amount for this pay (0 skips it); one without is a move the plan doesn't name, to a household account (toAccountId) or out of the household (match, the merchant key its transactions carry). by is cas, or you when the person set it. moves is every move from their pay this cycle as Home shows it: the plan's (id is the plan item) and the lines of their own (negative id), each with planned this pay, byNow, done so far and status, and note (Cas's reason). otherMoves are transfers out that nothing covers. accounts lists the ids to use. stale is true when a sync has brought something in since Cas last looked: redo_short_term looks again.",
    run: async () => {
      const current = await currentShortTerm()
      if (!current) return { shortTerm: null, reason: "No plan yet, or no accounts are marked as yours." }
      const { basis, saved, allocation, stale } = current
      const mine = new Set(basis.args.mine)
      return {
        cycle: allocation.cycle,
        pay: allocation.pay,
        summary: saved?.summary ?? null,
        madeBy: saved?.madeBy ?? null,
        updatedAt: saved?.updatedAt ?? null,
        stale,
        lines: saved?.lines ?? [],
        moves: allocation.moves,
        otherMoves: allocation.otherMoves,
        movesSoFar: basis.moves,
        accounts: basis.inputs.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balance, yours: mine.has(a.id) })),
      }
    },
  }),

  tool({
    name: "redo_short_term",
    title: "Have Cas redo this pay's moves",
    access: "action",
    description:
      "Have Cas work out this pay's transfers again now, replacing its short-term allocation (lines the person set are kept unless overtaken). Pass instruction with what they want changed, in their words, e.g. 'the $200 on the 25th was a loan to my brother, not paydown'; for something that should hold beyond this pay, also save_note it as a decision. Takes up to a minute and uses the Anthropic API key saved in Settings.",
    input: {
      instruction: z.string().trim().max(2000).optional().describe("What they want Cas to take into account, in their words"),
    },
    run: async ({ instruction }) => {
      const out = await refreshShortTerm({ force: true, instruction: instruction ?? null })
      if (!out) throw new Error("Cas can't allocate this pay: there's no plan, no accounts marked as yours, or no Anthropic API key in Settings.")
      return out.shortTerm
    },
  }),

  tool({
    name: "set_short_term",
    title: "Set this pay's moves",
    access: "action",
    description:
      "Set the transfers for the signed-in person's pay this pay cycle exactly as they say, replacing the whole list (pass every line to keep, from get_short_term). Each line is theirs, so Cas keeps it when it looks again. A line with planItemId sets that plan move's amount for this pay (0 skips it); without, it's a move the plan doesn't name: give toAccountId for a household account, or for money leaving the household toAccountId null and match (the merchant key from get_short_term's movesSoFar). fromAccountId must be one of theirs.",
    input: {
      lines: z
        .array(
          z.object({
            planItemId: z.number().int().positive().nullable(),
            title: z.string().trim().min(1).max(60),
            fromAccountId: z.number().int().positive(),
            toAccountId: z.number().int().positive().nullable(),
            match: z.string().trim().min(1).nullable(),
            amount: z.number().nonnegative(),
            dueDate: isoDate.nullable().describe("When it should have gone by; null for straight away"),
            reason: z.string().trim().min(1).max(200),
          })
        )
        .describe("Every line for this pay"),
      summary: z.string().trim().max(400).optional().describe("A new one-line summary; omit to keep Cas's"),
    },
    run: async ({ lines, summary }) => setShortTerm(lines, summary),
  }),

  tool({
    name: "list_imports",
    title: "Statement imports",
    access: "read",
    description: "Statement files imported by hand, newest first, with the account and dates each covered.",
    run: getStatements,
  }),

  tool({
    name: "get_corrections",
    title: "Corrections",
    access: "read",
    description:
      "The transactions the household moved by hand on Home (to another category, or to count towards a one-off payment), most recent first. waiting are still queued for Cas; recentlyTakenIn are the last 30 days' that Cas has taken in, each with its outcome. A move with rememberForMerchant becomes the merchant's rule when taken in; the rest are one-time exceptions. They tell you how the household sees its spending: weigh them before recategorizing that merchant or judging its category.",
    run: () => getCorrections(),
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
      "Remember something for later conversations: an observation worth tracking, a decision or preference you stated, or a to-do (with a due date if it has one). Write a to-do as one short line, action — why — how. One fact per note; don't save what the data already shows. ",
    input: {
      kind: z.enum(NOTE_KINDS),
      content: z.string().trim().min(1).max(1000),
      dueDate: isoDate.optional(),
    },
    run: async ({ kind, content, dueDate }) =>
      must<CasNote>(
        (await getDb())
          .from("cas_notes")
          .insert({ kind, content, due_date: dueDate ?? null })
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
    name: "move_transaction",
    title: "Move a transaction",
    access: "action",
    description:
      "Move one transaction to another category (categoryId, or null for uncategorized) or to count towards a one-off payment (oneOffId; it must be in the one-off's account), as Home's budget tracking does. Only that transaction changes now; it's queued for Cas, and with rememberForMerchant it becomes the merchant's rule when Cas takes the queue in (update_cas, or each morning).",
    input: {
      transactionId: z.number().int().positive(),
      categoryId: z.number().int().positive().nullable().optional(),
      oneOffId: z.number().int().positive().optional(),
      rememberForMerchant: z.boolean().optional(),
    },
    run: ({ transactionId, categoryId, oneOffId, rememberForMerchant }) => {
      if (oneOffId === undefined && categoryId === undefined) throw new Error("Give categoryId or oneOffId")
      return act(
        moveTransaction(
          transactionId,
          oneOffId !== undefined ? { oneOffId } : { categoryId: categoryId ?? null },
          rememberForMerchant ?? false
        )
      )
    },
  }),

  tool({
    name: "update_cas",
    title: "Take in the corrections",
    access: "action",
    description:
      "Take in every correction waiting in the queue now, rather than with the morning run: moves marked rememberForMerchant become merchant rules (moving that merchant's other auto-categorized and uncategorized transactions with them); the rest are recorded as one-time exceptions. Returns how many were processed, rules set and transactions recategorized.",
    run: () => act(updateCas()),
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
    name: "set_account_interest_rate",
    title: "Set an account's interest rate",
    access: "action",
    description:
      "Save the annual interest rate (percent, e.g. 8.95) on an account: what a loan, overdraft or card costs, or what savings earn. Null clears it. Cas and the plan use it to weigh paying down debt against saving.",
    input: {
      accountId: z.number().int().positive(),
      ratePercent: z.number().min(0).max(100).nullable(),
    },
    run: ({ accountId, ratePercent }) => act(setAccountInterestRate(accountId, ratePercent)),
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
    description:
      "Set the budget of one or more expense categories, weekly (Monday to Sunday) or monthly (the default): a fixed amount, or a percent of projected monthly income that stays in step as income moves. An amount of 0 clears it.",
    input: {
      budgets: z
        .array(
          z.object({
            categoryId: z.number().int().positive(),
            amount: z.number().nonnegative().optional().describe("A fixed amount for the period; omit when giving percent"),
            percent: z.number().positive().max(100).optional().describe("A percent of projected monthly income; omit when giving amount"),
            period: z.enum(BUDGET_PERIODS).optional(),
          })
        )
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
      form.set("valuedOn", valuedOn ?? todayLocal())
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
    name: "make_plan",
    title: "Have Cas make the plan",
    access: "action",
    description:
      "Have Cas make a new plan from today's income, budgets, bills and one-off payments and the goals given, replacing the current one on the Plan page (the old one is kept as history). Pass the goals in their words, with amounts and dates where they gave them; omit to keep the current plan's goals. Takes a minute or two and uses the Anthropic API key saved in Settings. Returns the verdict and the new plan.",
    input: {
      goals: z.string().trim().max(2000).optional().describe("What the plan should aim for; omit to keep the current goals"),
    },
    run: async ({ goals }) => {
      const keep = goals === undefined ? ((await getCurrentPlan())?.plan.goals ?? null) : goals || null
      const { planId, plan } = await makePlan(keep, "mcp")
      return { planId, ...plan }
    },
  }),

  tool({
    name: "set_plan_action_done",
    title: "Tick off a plan action",
    access: "action",
    description: "Mark one of the plan's to-do actions done (or not done again), by its id from get_plan.",
    input: { actionId: z.number().int().positive(), done: z.boolean() },
    run: async ({ actionId, done }) => {
      const [item] = await must<{ id: number }[]>(
        (await getDb())
          .from("plan_items")
          .update({ done_at: done ? new Date().toISOString() : null })
          .eq("id", actionId)
          .eq("kind", "action")
          .select("id")
      )
      if (!item) throw new Error("Plan action not found")
      return { actionId, done }
    },
  }),

  tool({
    name: "save_one_off",
    title: "Add or change a one-off payment",
    access: "action",
    description:
      "Add a one-off payment, a known cost coming up that money is put aside for in an account, or change one by passing its oneOffId from one_off_payments (fields left out stay as they are). It shows on the One-off payments page and Home, and the plan counts its monthly need. Moving it to another account unlinks the transactions in the old one.",
    input: {
      oneOffId: z.number().int().positive().optional().describe("The one-off to change; omit to add one"),
      name: z.string().trim().min(1).optional().describe("What it's for; needed when adding"),
      total: z.number().positive().optional().describe("The whole amount to pay, positive; needed when adding"),
      accountId: z.number().int().positive().optional().describe("The account the money is gathered in and paid from; needed when adding"),
      finishDate: isoDate.optional().describe("When it's paid, or the last part is; needed when adding"),
      startDate: isoDate.optional().describe("When putting money in starts. Defaults to today when adding."),
      outMode: z.enum(ONE_OFF_OUT_MODES).optional().describe("single: paid in one go on finishDate (the default); spread: in parts every outEvery until it"),
      outEvery: z.enum(ONE_OFF_FREQUENCIES).optional().describe("How often a part is paid, for a spread one"),
      inEvery: z.enum(ONE_OFF_FREQUENCIES).optional().describe("How often money goes in for it. Defaults to month."),
      setAside: z.number().nonnegative().optional().describe("Already in the account for it, not from a linked transaction"),
      note: z.string().optional(),
    },
    run: async ({ oneOffId, ...changes }) => {
      const current = oneOffId
        ? await must<OneOff | null>(
            (await getDb()).from("one_offs").select(COLUMNS.oneOffs).eq("id", oneOffId).maybeSingle()
          )
        : null
      if (oneOffId && !current) throw new Error("One-off payment not found")
      const o = {
        name: changes.name ?? current?.name,
        total: changes.total ?? current?.total,
        accountId: changes.accountId ?? current?.accountId,
        startDate: changes.startDate ?? current?.startDate ?? todayLocal(),
        finishDate: changes.finishDate ?? current?.finishDate,
        outMode: changes.outMode ?? current?.outMode ?? "single",
        outEvery: changes.outEvery ?? current?.outEvery ?? null,
        inEvery: changes.inEvery ?? current?.inEvery ?? "month",
        setAside: changes.setAside ?? current?.setAside ?? 0,
        note: changes.note ?? current?.note ?? null,
      }
      const form = new FormData()
      if (oneOffId) form.set("id", String(oneOffId))
      for (const [key, value] of Object.entries(o)) {
        if (value !== undefined && value !== null) form.set(key, String(value))
      }
      return act(saveOneOff(form))
    },
  }),

  tool({
    name: "link_one_off_transactions",
    title: "Count transactions towards a one-off",
    access: "action",
    description:
      "Count transactions towards a one-off payment: money in for it, or a payment out of it. Each must be in the one-off's account and not already count towards another; the linkable list on one_off_payments has them. A linked payment comes out of its category's spending and budget, since the one-off's money pays for it; there's no need to recategorize it.",
    input: {
      oneOffId: z.number().int().positive(),
      transactionIds: z.array(z.number().int().positive()).min(1),
    },
    run: ({ oneOffId, transactionIds }) => act(linkOneOffTransactions(oneOffId, transactionIds)),
  }),

  tool({
    name: "unlink_one_off_transaction",
    title: "Stop counting a transaction towards a one-off",
    access: "action",
    description: "Stop counting a transaction towards the one-off payment it's linked to.",
    input: { transactionId: z.number().int().positive() },
    run: ({ transactionId }) => act(unlinkOneOffTransaction(transactionId)),
  }),

]
