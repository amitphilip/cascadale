import "server-only"

import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import {
  CheckInResultSchema,
  type CheckInResult,
  type CheckInStats,
} from "@/lib/checkin-types"
import { balanceChanges, sinceCheckIn, withoutLoanAccounts } from "@/lib/checkin-window"
import { getDb, must, selectAll } from "@/lib/db"
import {
  combinedLow,
  FORTNIGHTLY,
  isCashAccount,
  MONTHLY,
  simulate,
  type PlanSnapshot,
} from "@/lib/plan"
import { latestPlan, loadSnapshot } from "@/lib/planner"
import { goalPlan, planGoal } from "@/lib/plan-goal"
import { supabasePlanRepo } from "@/lib/plan-repo"
import { potLedgers, withInstructions } from "@/lib/plan-service"
import { potHealth } from "@/lib/pots"
import {
  getAccountsWithBalances,
  getGoalThread,
  getPlanThread,
  getTransactionAmounts,
} from "@/lib/queries"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 32000
const DAYS_PER_MONTH = 365.25 / 12
/** Looked at when nothing new was logged since the last check-in. */
const RECENT_DAYS = 30
const BILLS_AHEAD = 30
const ONE_OFFS_AHEAD = 90
const PROJECT_DAYS = 60

const round2 = (n: number) => Math.round(n * 100) / 100
const toIso = (d: Date) => format(d, "yyyy-MM-dd")

type Row = {
  date: string
  description: string
  amount: number
  accountId: number
  categoryName: string | null
  categoryKind: string | null
  /** the sinking fund it was drawn from, if any */
  pot: string | null
}

/**
 * Transactions logged since the last check-in and dated from its last day on, else the last
 * 30 days; transfers excluded.
 */
async function newTransactions() {
  const db = await (await getDb())
  const [last] = await must<{ createdAt: string; periodEnd: string }[]>(
    db
      .from("check_ins")
      .select("createdAt:created_at, periodEnd:period_end")
      .order("id", { ascending: false })
      .limit(1)
  )
  /** Logged after `since`, or with no `since`, in the last RECENT_DAYS days of data. */
  const query = async (since: string | null) =>
    (
      await must<Row[]>(
        db.rpc("checkin_transactions", { p_since: since, p_recent_days: RECENT_DAYS })
      )
    ).map((x): Row => ({ ...x, amount: Number(x.amount) }))

  if (last) {
    const rows = sinceCheckIn(await query(last.createdAt), last.periodEnd)
    if (rows.length > 0) return { rows, basis: "new" as const }
  }
  const recent = await query(null)
  return { rows: recent, basis: last ? ("recent" as const) : ("new" as const) }
}

/** Same direction rule as the budget: categorized by kind, uncategorized by sign. */
const isIncome = (r: Row) =>
  r.categoryKind ? r.categoryKind === "income" : r.amount > 0

/** What happened since the last check-in, against what the usual pattern expects. */
export async function buildStats(snap: PlanSnapshot): Promise<CheckInStats> {
  const [
    { rows: logged, basis },
    accountRows,
    thread,
    started,
    balances,
    allTxs,
  ] = await Promise.all([
    newTransactions(),
    must<{ id: number; name: string; type: string }[]>(
      (await getDb()).from("accounts").select("id, name, type")
    ),
    getPlanThread(),
    getGoalThread(),
    getAccountsWithBalances(),
    getTransactionAmounts(),
  ])
  const rows = withoutLoanAccounts(logged, accountRows)
  const accountName = (id: number | null) =>
    accountRows.find((a) => a.id === id)?.name ?? "Unknown account"

  const from = rows[0]?.date ?? snap.dataEnd
  const to = rows.at(-1)?.date ?? snap.dataEnd
  const days = differenceInCalendarDays(parseISO(to), parseISO(from)) + 1
  const share = days / DAYS_PER_MONTH

  // a fund's draws were planned for: they're reported with the fund, not against the pace
  const potRows = rows.filter((r) => r.pot && !isIncome(r))
  const incomeRows = rows.filter(isIncome)
  const expenseRows = rows.filter((r) => !isIncome(r) && !r.pot)
  const income = round2(incomeRows.reduce((s, r) => s + r.amount, 0))
  const spending = round2(-expenseRows.reduce((s, r) => s + r.amount, 0))

  const spentBy = new Map<string, number>()
  for (const r of expenseRows) {
    const name = r.categoryName ?? "Uncategorized out"
    spentBy.set(name, (spentBy.get(name) ?? 0) - r.amount)
  }
  const expectedBy = new Map(
    snap.budgets.map((b) => [b.category, b.projected * share])
  )
  const categoryNames = new Set([
    ...spentBy.keys(),
    ...[...expectedBy].filter(([, v]) => v >= 1).map(([k]) => k),
  ])
  const categoryStats = [...categoryNames]
    .map((name) => ({
      name,
      spent: round2(spentBy.get(name) ?? 0),
      expected: round2(expectedBy.get(name) ?? 0),
    }))
    .sort(
      (a, b) => Math.max(b.spent, b.expected) - Math.max(a.spent, a.expected)
    )
    .slice(0, 12)

  const sum = (xs: { monthly: number }[]) =>
    xs.reduce((s, x) => s + x.monthly, 0)
  // what each balance actually did over these dates, so transfers count here
  const db = await getDb()
  const changeBy = balanceChanges(
    await selectAll<{ accountId: number; amount: number }>((start, end) =>
      db
        .from("transactions")
        .select("accountId:account_id, amount")
        .gte("date", from)
        .lte("date", to)
        .order("id")
        .range(start, end)
    )
  )

  // Project from today with no plan: what the accounts look like if nothing changes.
  const sim = simulate(snap, null, PROJECT_DAYS)
  const billsUntil = toIso(addDays(parseISO(snap.start), BILLS_AHEAD))
  const oneOffsUntil = toIso(addDays(parseISO(snap.start), ONE_OFFS_AHEAD))
  const low = combinedLow(snap, sim)

  const funds = await potLedgers({ repo: supabasePlanRepo(db), loadSnapshot: async () => snap })
  const base = thread && latestPlan(thread.messages)
  const startedPlan = started && latestPlan(started.messages)
  const live =
    thread && base
      ? await withInstructions(supabasePlanRepo(db), snap, { snapshot: thread.snapshot, plan: base })
      : null
  const plan = live?.plan ?? null
  const goal =
    thread && base && live
      ? planGoal({
          goal: goalPlan(
            startedPlan && { snapshot: started.snapshot, plan: startedPlan },
            { snapshot: thread.snapshot, plan: base },
            todayLocal()
          ),
          latest: live.plan,
          current: live.snapshot,
          balances: new Map(balances.map((a) => [a.id, a.balance])),
          txs: allTxs,
        })
      : null
  const when = (incomeId: string) =>
    incomeId === MONTHLY
      ? "1st of each month"
      : incomeId === FORTNIGHTLY
        ? "every fortnight"
        : `when ${snap.incomes.find((i) => i.id === incomeId)?.name ?? "pay"} lands`

  return {
    from,
    to,
    days,
    basis,
    newCount: rows.length,
    currency: snap.currency,
    income,
    spending,
    net: round2(income - spending),
    expectedIncome: round2((sum(snap.incomes) + sum(snap.otherIncome)) * share),
    expectedSpending: round2((sum(snap.bills) + sum(snap.variable)) * share),
    incomeItems: incomeRows
      .toSorted((a, b) => b.amount - a.amount)
      .slice(0, 6)
      .map((r) => ({
        date: r.date,
        description: r.description,
        amount: r.amount,
        account: accountName(r.accountId),
      })),
    bigExpenses: expenseRows
      .toSorted((a, b) => a.amount - b.amount)
      .slice(0, 6)
      .map((r) => ({
        date: r.date,
        description: r.description,
        amount: -r.amount,
        category: r.categoryName ?? "Uncategorized",
      })),
    categories: categoryStats,
    potDraws: potRows.map((r) => ({
      date: r.date,
      description: r.description,
      amount: -r.amount,
      category: r.categoryName ?? "Uncategorized",
      pot: r.pot!,
    })),
    pots: funds.ledgers.map(potHealth),
    accounts: snap.accounts.map((a) => ({
      name: a.name,
      type: a.type,
      balance: a.balance,
      change: round2(changeBy.get(a.id) ?? 0),
    })),
    cashNow: round2(
      snap.accounts
        .filter((a) => isCashAccount(a.type))
        .reduce((s, a) => s + a.balance, 0)
    ),
    upcomingBills: sim.events
      .filter((e) => e.kind === "bill" && !e.oneOff && e.date <= billsUntil)
      .map((e) => ({
        date: e.date,
        name: e.name,
        amount: e.amount,
        account: accountName(e.accountId),
      })),
    upcomingOneOffs: (snap.upcoming ?? [])
      .filter((u) => u.date <= oneOffsUntil)
      .map((u) => ({
        date: u.date,
        name: u.name,
        amount: u.amount,
        account: u.accountId === null ? null : accountName(u.accountId),
      })),
    low,
    plan: plan
      ? {
          summary: plan.summary,
          setAsides: plan.set_asides.map((s) => ({
            pot: s.pot,
            amount: s.amount,
            when: when(s.income_id),
            to: accountName(s.to_account_id ?? s.from_account_id),
          })),
        }
      : null,
    goal: goal && {
      endDate: goal.endDate,
      target: goal.target,
      targetSplit: goal.targetSplit,
      forecast: goal.forecast,
      forecastSplit: goal.forecastSplit,
      gap: goal.gap,
      latest: goal.latest,
      debt: goal.debt,
    },
  }
}

const SYSTEM = `You are a personal-finance coach inside a private budgeting app used by one person or household. They have just logged new bank statements. You get analytics the app computed from what was logged, compared with what their plan expects, plus what is coming up. Tell them where they stand and what to do now to stay on their plan.

The data (amounts in the stated currency):
- from/to/days: the dates the new transactions cover. basis "new" means logged since the last check-in; "recent" means nothing new was logged, so it is the last 30 days.
- income/spending/net: totals over those days, transfers between their own accounts excluded. expectedIncome/expectedSpending: what their usual pattern predicts for the same number of days.
- incomeItems, bigExpenses: the largest money in and out. categories: spending per category against its expectation for those days.
- potDraws: payments drawn from a sinking fund (planned, lumpy costs such as air tickets or invoices). They are left out of spending and categories, so don't call them overspending.
- pots: each sinking fund's health: balance, contributed and spent this cycle, cap and capUsedPct, capRemaining, plannedTotal, the next planned draw, shortfall (how far the balance falls short of a planned draw), suggestedContribution per period (frequency) to reach the cap or planned total by endDate, and warnings. Report on each fund briefly; when it's over its cap or short of its next draw, say so and give the fix (top up, raise the contribution to the suggested amount, or move the draw).
- accounts: balances now (credit cards and loans negative when owed) and how much each balance moved between from and to, transfers included. cashNow: total in cash accounts.
- upcomingBills: recurring bills in the next 30 days. upcomingOneOffs: one-off expenses they told the app about, in the next 90 days.
- low: the lowest projected combined balance of all accounts except loans over the next 60 days if spending keeps its usual pace, with the date. Transfers between their own accounts aren't projected, so judge affordability on this combined figure. Below zero means they can't cover what's coming.
- plan: their current plan's summary and set-asides (pot, amount, when, where the money goes), or null if they have none.
- goal: the plan's end goal as a net position: cash held less what's owed on cards and overdrafts. Loans and revolving credit (flexi) accounts are debt and are left out; goal.debt tracks what's owed on revolving credit (startedAt, now, target and forecast for the end date), so paying it down shows there, not as a fall in the goal. target: what the plan they started said it would be by endDate; forecast: where today's plan now lands; gap: forecast less target plus any revolving credit paid down beyond the plan, below zero means short. targetSplit and forecastSplit give the cash and owed parts, so a fall in cash that pays debt down isn't a shortfall. latest: planned against actual net on the last day with data, with its cash and owed; offPlan is the difference with revolving credit counted. Null without a plan. Never call the net figure a cash balance.

How to answer:
- paragraph: name what actually happened, e.g. "Your salary of 4,200 landed on 1 Oct, but spending ran 380 over the usual pace, mostly Dining." Then what is coming and whether the money is there for it.
- actions: concrete moves for the next days: an amount to move, a category to slow down, a bill to check. Ground each in the numbers.
- plan_changes: when an upcoming one-off, an annual bill or a projected low needs the plan to bend for a while, say on which date to change what and by how much (e.g. "From 15 Nov payday, add 150 to Annual bills for two paydays"). Leave it empty when the plan holds as is.
- The goal is the point of the plan; day-to-day deviations are expected. When the gap is below zero, the actions and plan_changes should between them win it back by endDate: say how much each one recovers. When the gap is zero or above, say so and don't invent cuts.
- status: on_track when the goal's gap is zero or above, income and spending are near expectations and the low stays above zero; off_track when the low is below zero, spending is far over or the gap is more than a tenth of a month's income short; watch in between.
- A partial period (a few days) naturally has less income or spending than a full month; judge pace, not totals, and don't alarm about a payday that simply hasn't come yet.
Keep every text short and plain, lead with numbers, refer to accounts and bills by name. Don't invent facts the data doesn't show; when you assume something, say so.`

async function ask(stats: CheckInStats): Promise<CheckInResult> {
  const client = await anthropicClient()
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: betaZodOutputFormat(CheckInResultSchema),
      },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Today is ${todayLocal()}. Here is what I just logged:\n<data>\n${JSON.stringify(stats)}\n</data>`,
        },
      ],
    })
    const response = await stream.finalMessage()
    if (response.stop_reason === "refusal")
      throw new Error("The model declined to answer")
    if (response.stop_reason === "max_tokens")
      throw new Error("The model's answer was cut off; try again")
    if (!response.parsed_output)
      throw new Error("The model returned a malformed check-in")
    return response.parsed_output
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}

/** Compute the analytics, ask the model, and save both. */
export async function runCheckIn() {
  const snap = await loadSnapshot()
  if (!snap) throw new Error("Import some transactions first")
  const stats = await buildStats(snap)
  const result = await ask(stats)
  const row = await must<{ id: number }>(
    (await getDb())
      .from("check_ins")
      .insert({ period_start: stats.from, period_end: stats.to, stats, result })
      .select("id")
      .single()
  )
  return { id: row.id, status: result.status }
}
