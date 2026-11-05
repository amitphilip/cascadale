import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowDownLeftIcon,
  ArrowRightIcon,
  CaretRightIcon,
  CheckCircleIcon,
  PiggyBankIcon,
  PlusIcon,
  SparkleIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/ssr"

import { CategoryBreakdown } from "./category-breakdown"
import { AccountHoldersCard } from "./account-holders-card"
import { PlanBudgetCard } from "./plan-budget-card"
import { ViewSwitcher } from "./view-switcher"
import { NewPlanDialog } from "./new-plan-dialog"
import { PlanChangesCard } from "./plan-changes-card"
import { PlanGoalCard } from "./plan-goal-card"
import { PlanStatusCard } from "./plan-status-card"
import {
  AllocationCard,
  NetWorthCard,
  UpcomingCard,
  type Allocation,
} from "./plan-summary-cards"
import { PlanTodoCard, type Suggestion } from "./plan-todo-card"
import { PlanProposalsCard } from "./plan-proposals-card"
import { PlanAsk } from "./plan-ask"
import { type ChatMessage } from "./plan-chat"
import { PageHeader } from "@/components/page-header"
import { TimelineChart, type Series } from "@/components/plan-charts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  formatDate,
  formatMoney,
  SERIES_COLORS,
  type MoneyFormat,
} from "@/lib/format"
import {
  HORIZON_DAYS,
  FORTNIGHTLY,
  isCashAccount,
  MONTHLY,
  simulate,
  type Plan,
  type PlanSnapshot,
  type Simulation,
} from "@/lib/plan"
import {
  buildNetWorth,
  monthEnds,
  netWorthHistory,
  pointBack,
} from "@/lib/net-worth"
import { categoryCosts, monthBudget, spareCash } from "@/lib/plan-budget"
import { type PlanGoal } from "@/lib/plan-goal"
import { goalFor } from "@/lib/plan-figures"
import { planStanding, planVerdict, withGoal } from "@/lib/plan-verdict"
import { getPlanState, withInstructions } from "@/lib/plan-service"
import { planDeps } from "@/lib/plan-repo"
import { chatMessages, latestPlan, loadSnapshot } from "@/lib/planner"
import {
  getAccountsWithBalances,
  getAssets,
  getCategories,
  getAccountHolders,
  getCategorySpend,
  getCategorySpendFor,
  getCheckIns,
  getMyPrefs,
  getPeople,
  getGoalThread,
  getOpenCasNotes,
  getPlanActions,
  getPlanThread,
  getSettings,
  getTransactionAmounts,
} from "@/lib/queries"
import { CADENCE_LABELS } from "@/lib/recurring"
import { getUserId } from "@/lib/db"
import { casStore } from "@/lib/cas/store-db"
import { cn } from "@/lib/utils"
import { parseView } from "@/lib/views"
import { localDate, todayLocal } from "@/supabase/functions/_shared/akahu"

export const metadata: Metadata = { title: "Plan" }

/** Cas can take a few minutes over a question in the chat. */
export const maxDuration = 300

/** Days of upcoming bills and paydays listed. */
const UPCOMING_DAYS = 14
/** Regular income smaller than this, such as bank interest, isn't worth a payday card. */
const MIN_PAYDAY = 50
/** Month-ends of net worth charted. */
const HISTORY_MONTHS = 12
/** How far back the verdict compares net worth and debts. */
const TREND_MONTHS = 3
/** Chat messages shown; older ones stay stored. */
const MAX_CHAT = 40
/** Cas notes shown on the status card. */
const MAX_NOTES = 4
/** Pots and accounts beyond this many share a neutral color, never a sixth hue. */
const MAX_SERIES = SERIES_COLORS.length
const OTHER_COLOR = "var(--muted-foreground)"
const SPEND_COLOR =
  "color-mix(in oklch, var(--muted-foreground) 45%, transparent)"
const LEFT_COLOR =
  "color-mix(in oklch, var(--muted-foreground) 18%, transparent)"

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const userId = await getUserId()
  const [
    fmt,
    thread,
    current,
    deps,
    accounts,
    assets,
    txs,
    actions,
    checkIns,
    notes,
    started,
    categories,
    spend,
    people,
    prefs,
    holders,
    proposals,
    params,
  ] = await Promise.all([
    getSettings(),
    getPlanThread(),
    loadSnapshot(),
    planDeps("website"),
    getAccountsWithBalances(),
    getAssets(),
    getTransactionAmounts(),
    getPlanActions(),
    getCheckIns(1),
    getOpenCasNotes(),
    getGoalThread(),
    getCategories(),
    getCategorySpend(todayLocal().slice(0, 7)),
    getPeople(),
    getMyPrefs(userId),
    getAccountHolders(),
    casStore().then((store) => store.listProposals(["pending"])),
    searchParams,
  ])
  // you open on your own view or the family's, as you chose in Settings
  const view = parseView(params.view) ?? prefs.homeView
  const me = people.find((p) => p.id === userId)
  const myName = prefs.name ?? me?.name ?? "Me"
  const mine = new Set(
    [...holders].filter(([, holder]) => holder === userId).map(([id]) => id)
  )

  if (!current) {
    return (
      <>
        <PageHeader title="Plan" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UploadSimpleIcon />
            </EmptyMedia>
            <EmptyTitle>Import some statements first</EmptyTitle>
            <EmptyDescription>
              The planner needs a few months of transactions.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<Link href="/import" />}>
              Import statements <ArrowRightIcon />
            </Button>
          </EmptyContent>
        </Empty>
      </>
    )
  }

  const base = thread && latestPlan(thread.messages)
  const state = await getPlanState(deps)

  if (!thread || !base) {
    return (
      <>
        <PageHeader title="Plan" />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparkleIcon />
            </EmptyMedia>
            <EmptyTitle>Plan where each payday’s money goes</EmptyTitle>
            <EmptyDescription>
              {current.incomes.length} regular{" "}
              {current.incomes.length === 1 ? "income" : "incomes"} ·{" "}
              {current.bills.length} bills · {current.accounts.length} accounts
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <NewPlanDialog trigger={<Button>Create a plan</Button>} />
          </EmptyContent>
        </Empty>
      </>
    )
  }

  // the plan as it stands: today's data, with every pot and adjustment in it
  const { snapshot: snap, plan } = await withInstructions(deps.repo, current, {
    snapshot: thread.snapshot,
    plan: base,
  })
  const today = todayLocal()
  const sim = simulate(snap, plan)
  const colors = potColors(sim)
  const worth = buildNetWorth(accounts, assets)
  const history = netWorthHistory(
    accounts,
    txs,
    worth.totals.assets,
    monthEnds(snap.dataEnd, HISTORY_MONTHS)
  )
  const from = pointBack(history, TREND_MONTHS)
  const waiting = state.unappliedDecisions.length > 0
  const startedPlan = started && latestPlan(started.messages)
  const goal = goalFor({
    started: startedPlan && { snapshot: started.snapshot, plan: startedPlan },
    base: { snapshot: thread.snapshot, plan: base },
    live: { snapshot: snap, plan },
    balances: new Map(accounts.map((a) => [a.id, a.balance])),
    txs,
    today,
  })
  const baseVerdict = planVerdict({
    sim,
    warnings: plan.warnings,
    balanceOf: (id) => snap.accounts.find((a) => a.id === id)?.balance ?? 0,
    accountName: (id) => accountName(snap, id),
    trend: from
      ? { months: TREND_MONTHS, from, to: history[history.length - 1] }
      : null,
    money: (n) => formatMoney(n, fmt),
    date: (iso) => formatDate(iso, fmt.locale),
  })
  const verdict = withGoal(
    baseVerdict,
    goal,
    (n) => formatMoney(n, fmt),
    (iso) => formatDate(iso, fmt.locale)
  )
  const checkIn = checkIns[0] ?? null
  const costs = categoryCosts(snap)
  const month = monthBudget(costs, spend, today)
  const categoryId = new Map(
    categories.filter((c) => c.kind === "expense").map((c) => [c.name, c.id])
  )
  const myCosts = categoryCosts(snap, mine)
  const myMonth = monthBudget(
    myCosts,
    await getCategorySpendFor(today.slice(0, 7), [...mine]),
    today
  )
  const myIncomes = new Set(
    snap.incomes.filter((i) => mine.has(i.accountId)).map((i) => i.id)
  )
  const plannedBudgets = costs.flatMap((c) => {
    const id = categoryId.get(c.category)
    return id === undefined
      ? []
      : [{ categoryId: id, amount: Math.round(c.bills + c.dayToDay) }]
  })
  const standing = planStanding({
    verdict,
    checkIn: checkIn
      ? {
          status: checkIn.result.status,
          headline: checkIn.result.headline,
          periodEnd: checkIn.periodEnd,
        }
      : null,
    dataEnd: snap.dataEnd,
  })
  // decisions show under changes; what Cas saw and still has to do belongs with the status
  const observations = notes
    .filter((n) => n.kind === "observation" || n.kind === "todo")
    .slice(0, MAX_NOTES)

  // what the plan and the last check-in suggest doing; an old check-in's dated advice only while it's still ahead
  const checkInLabel = checkIn
    ? `Check-in ${formatDate(localDate(checkIn.createdAt), fmt.locale)}`
    : ""
  const suggestions: Suggestion[] = [
    ...plan.focus.map((f, i) => ({
      key: `focus-${i}`,
      title: f.title,
      detail: f.detail,
      source: "From the plan",
      priority: f.priority,
      impact: f.monthly_impact,
    })),
    ...(checkIn?.result.actions ?? [])
      .filter((a) => !standing.stale || (a.by !== null && a.by >= today))
      .map((a, i) => ({
        key: `checkin-${i}`,
        title: a.title,
        detail: a.detail,
        source: checkInLabel,
        amount: a.amount,
        dueDate: a.by,
      })),
  ]

  const messages: ChatMessage[] = chatMessages(thread, thread.messages)
    .slice(-MAX_CHAT)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      // a thread's first reply is the plan itself, not a change to it
      changed: m.role === "assistant" && m.plan !== null && m !== thread.messages[1],
    }))

  return (
    <>
      <PageHeader
        title="Plan"
        iconActions
        description={`Data to ${formatDate(snap.dataEnd, fmt.locale)} · ${HORIZON_DAYS}-day projection`}
      >
        <NewPlanDialog
          trigger={
            <Button
              variant="outline"
              size="icon"
              aria-label="New plan"
              title="New plan"
            >
              <PlusIcon />
            </Button>
          }
        />
      </PageHeader>

      <ViewSwitcher view={view} me={myName} />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        {view === "me" && (
          <div className="grid min-w-0 gap-6">
            {mine.size === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>No accounts are marked as yours yet</EmptyTitle>
                  <EmptyDescription>
                    Say whose each account is in the accountant view, and this
                    page shows your pay, your spending and your accounts.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={<Link href="/plan?view=accountant#whose-accounts" />}
                  >
                    Set whose accounts <ArrowRightIcon />
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <>
                <FamilyGoalLine goal={goal} fmt={fmt} />
                <PaydayCards
                  snap={snap}
                  plan={plan}
                  colors={colors}
                  fmt={fmt}
                  incomes={myIncomes}
                  title="On your payday, move"
                />
                <PlanBudgetCard
                  budget={myMonth}
                  spare={null}
                  goalGap={goal.gap}
                  budgets={[]}
                  fmt={fmt}
                  title="Your"
                />
                <MyAccountsCard snap={snap} sim={sim} ids={mine} fmt={fmt} />
              </>
            )}
            <PlanTodoCard
              actions={actions}
              suggestions={suggestions}
              today={today}
              fmt={fmt}
            />
          </div>
        )}

        {view === "family" && (
          <div className="grid min-w-0 gap-6">
            <PlanGoalCard summary={plan.summary} goal={goal} fmt={fmt} />
            <PlanProposalsCard proposals={proposals} locale={fmt.locale} />
            <PlanBudgetCard
              budget={month}
              spare={spareCash(snap, sim)}
              goalGap={goal.gap}
              budgets={plannedBudgets}
              fmt={fmt}
            />
            <PlanTodoCard
              actions={actions}
              suggestions={suggestions}
              today={today}
              fmt={fmt}
            />
            <PaydayCards snap={snap} plan={plan} colors={colors} fmt={fmt} />
            {waiting && (
              <PlanChangesCard
                state={state}
                snap={snap}
                checkIn={checkIn}
                today={today}
                fmt={fmt}
              />
            )}
          </div>
        )}

        {view === "accountant" && (
          <div className="grid min-w-0 gap-6">
            <PlanProposalsCard proposals={proposals} locale={fmt.locale} />
            <PlanStatusCard
              standing={standing}
              verdict={verdict}
              checkIn={checkIn}
              notes={observations}
              fmt={fmt}
            />
            <PlanChangesCard
              state={state}
              snap={snap}
              checkIn={checkIn}
              today={today}
              fmt={fmt}
            />
            <AllocationCard
              income={sim.monthly.income}
              rows={allocation(sim, colors, snap)}
              fmt={fmt}
            />
            <CategoryBreakdown
              threadId={thread.id}
              costs={costs}
              leftOver={sim.monthly.free}
              fmt={fmt}
            />
            <UpcomingCard
              events={sim.events.filter(
                (e) =>
                  e.date <=
                  sim.days[Math.min(UPCOMING_DAYS, sim.days.length) - 1]
              )}
              days={UPCOMING_DAYS}
              accountName={(id) => accountName(snap, id)}
              fmt={fmt}
            />
            <NetWorthCard
              history={history}
              owned={worth.owned}
              owed={worth.totals.debts}
              fmt={fmt}
            />
            <PotsCard snap={snap} sim={sim} colors={colors} fmt={fmt} />
            <BalancesCard snap={snap} sim={sim} fmt={fmt} />
            <div id="whose-accounts" className="scroll-mt-8">
              <AccountHoldersCard
                accounts={accounts
                  .filter((a) => !a.archived)
                  .map((a) => ({
                    id: a.id,
                    name: a.name,
                    holderId: holders.get(a.id) ?? null,
                  }))}
                people={people}
              />
            </div>
          </div>
        )}

        <PlanAsk threadId={thread.id} messages={messages} />
      </div>
      <div className="h-14 xl:hidden" aria-hidden />
    </>
  )
}

type Colors = Map<string, string>
type Props = { snap: PlanSnapshot; sim: Simulation; fmt: MoneyFormat }

function potColors(sim: Simulation): Colors {
  const ordered = [...sim.potSummaries].sort(
    (a, b) => b.monthlyIn - a.monthlyIn
  )
  return new Map(
    ordered.map((p, i) => [p.name, SERIES_COLORS[i] ?? OTHER_COLOR])
  )
}

/** The month's income, pot by pot, then spending and what's left. */
function allocation(
  sim: Simulation,
  colors: Colors,
  snap: PlanSnapshot
): Allocation[] {
  return [
    ...sim.potSummaries
      .toSorted((a, b) => b.monthlyIn - a.monthlyIn)
      .map((p) => ({
        key: p.name,
        label: p.name,
        detail: p.covers.length
          ? `Pays ${p.covers.length} ${p.covers.length === 1 ? "bill" : "bills"}`
          : `Stays in ${accountName(snap, p.accountId)}`,
        color: colors.get(p.name)!,
        value: p.monthlyIn,
      })),
    {
      key: "spend",
      label: "Day-to-day spending",
      color: SPEND_COLOR,
      value: sim.monthly.variable,
    },
    {
      key: "left",
      label: "Left over",
      color: LEFT_COLOR,
      value: sim.monthly.free,
    },
  ]
}

const accountName = (snap: PlanSnapshot, id: number) =>
  snap.accounts.find((a) => a.id === id)?.name ?? "Unknown account"

const money = (n: number, fmt: MoneyFormat) =>
  formatMoney(n, fmt, { compact: Math.abs(n) >= 10000 })

type Segment = { key: string; label: string; color: string; value: number }

function StackBar({
  segments,
  fmt,
  className,
}: {
  segments: Segment[]
  fmt: MoneyFormat
  className?: string
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0)
  if (total <= 0) return null
  return (
    <div
      className={cn(
        "flex h-4 w-full gap-0.5 overflow-hidden rounded-md",
        className
      )}
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.key}
            className="h-full min-w-1 first:rounded-l-md last:rounded-r-md"
            style={{
              width: `${(s.value / total) * 100}%`,
              backgroundColor: s.color,
            }}
            title={`${s.label}: ${formatMoney(s.value, fmt)}`}
          />
        ))}
    </div>
  )
}

function PaydayCards({
  snap,
  plan,
  colors,
  fmt,
  incomes,
  title = "On each payday, move",
}: {
  snap: PlanSnapshot
  plan: Plan
  colors: Colors
  fmt: MoneyFormat
  /** only these incomes, without the monthly and fortnightly set-asides */
  incomes?: Set<string>
  title?: string
}) {
  const sources = [
    ...snap.incomes.map((i) => ({
      id: i.id,
      name: i.name,
      when: CADENCE_LABELS[i.cadence],
      amount: i.amount,
      accountId: i.accountId as number | null,
    })),
    ...[
      {
        id: FORTNIGHTLY,
        name: "Every fortnight",
        when: "Fortnightly",
        amount: 0,
        accountId: null,
      },
      {
        id: MONTHLY,
        name: "1st of the month",
        when: "Monthly",
        amount: 0,
        accountId: null,
      },
    ].filter((src) => plan.set_asides.some((s) => s.income_id === src.id)),
  ]
  const funding = sources.filter(
    (src) =>
      (!incomes || incomes.has(src.id)) &&
      (src.amount >= MIN_PAYDAY ||
        plan.set_asides.some((s) => s.income_id === src.id))
  )
  if (funding.length === 0) return null
  return (
    <section className="grid gap-3">
      <h3 className="flex items-center gap-2 font-heading font-semibold">
        <ArrowDownLeftIcon /> {title}
      </h3>
      <div className="grid gap-4 lg:grid-cols-2">
        {funding.map((src) => {
          const entries = plan.set_asides.filter((s) => s.income_id === src.id)
          const total = entries.reduce((s, x) => s + x.amount, 0)
          const left = Math.max(0, src.amount - total)
          const segments: Segment[] = [
            ...entries.map((e, i) => ({
              key: `${e.pot}-${i}`,
              label: e.pot,
              color: colors.get(e.pot) ?? OTHER_COLOR,
              value: e.amount,
            })),
            ...(src.amount
              ? [
                  {
                    key: "left",
                    label: "Left to spend",
                    color: LEFT_COLOR,
                    value: left,
                  },
                ]
              : []),
          ]
          return (
            <Card key={src.id} size="sm">
              <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={src.name}>
                      {src.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {src.when}
                      {src.accountId !== null &&
                        ` · into ${accountName(snap, src.accountId)}`}
                    </div>
                  </div>
                  {src.amount > 0 && (
                    <div className="shrink-0 font-heading text-lg font-semibold tabular-nums">
                      {money(src.amount, fmt)}
                    </div>
                  )}
                </div>
                <StackBar segments={segments} fmt={fmt} />
                {entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing set aside from this income.
                  </p>
                ) : (
                  <ul className="grid gap-2 text-sm">
                    {entries.map((e, i) => (
                      <li
                        key={i}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2"
                        title={e.note}
                      >
                        <span
                          className="mt-1 size-2.5 rounded-[3px]"
                          style={{
                            backgroundColor: colors.get(e.pot) ?? OTHER_COLOR,
                          }}
                        />
                        <div className="min-w-0">
                          <div className="font-medium">{e.pot}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {e.to_account_id === null
                              ? "stays here"
                              : `to ${accountName(snap, e.to_account_id)}`}
                          </div>
                        </div>
                        <span className="font-medium tabular-nums">
                          {formatMoney(e.amount, fmt)}
                        </span>
                      </li>
                    ))}
                    {src.amount > 0 && (
                      <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 border-t pt-1.5 text-muted-foreground">
                        <span
                          className="size-2.5 rounded-[3px]"
                          style={{ backgroundColor: LEFT_COLOR }}
                        />
                        Left to spend
                        <span className="tabular-nums">
                          {formatMoney(left, fmt)}
                        </span>
                      </li>
                    )}
                  </ul>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}

function PotsCard({ snap, sim, colors, fmt }: Props & { colors: Colors }) {
  if (sim.potSummaries.length === 0) return null
  const charted = sim.potSummaries
    .toSorted((a, b) => b.monthlyIn - a.monthlyIn)
    .slice(0, MAX_SERIES)
  const series: Series[] = charted.map((p, i) => ({
    key: `p${i}`,
    label: p.name,
    color: colors.get(p.name)!,
    values: sim.pots[p.name],
  }))
  const billName = (id: string) =>
    snap.bills.find((b) => b.id === id)?.name ?? id

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBankIcon /> Pots
        </CardTitle>
        <CardDescription>
          Fills on payday, empties as bills go out.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <TimelineChart days={sim.days} series={series} fmt={fmt} step />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sim.potSummaries.map((p) => {
            const short = p.monthlyIn + 0.5 < p.monthlyOut
            const savings = p.covers.length === 0
            return (
              <div
                key={p.name}
                className="grid content-start gap-2 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: colors.get(p.name) }}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {p.name}
                  </span>
                  {short ? (
                    <Badge variant="destructive" className="shrink-0">
                      <WarningCircleIcon /> Short
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      <CheckCircleIcon /> {savings ? "Saving" : "Funded"}
                    </Badge>
                  )}
                </div>
                <div className="font-heading text-lg font-semibold tabular-nums">
                  {formatMoney(p.monthlyIn, fmt)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    /mo in
                  </span>
                </div>
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span className="truncate">
                    {accountName(snap, p.accountId)}
                  </span>
                  {!savings && (
                    <span title={p.covers.map(billName).join(", ")}>
                      Pays {p.covers.length}{" "}
                      {p.covers.length === 1 ? "bill" : "bills"} ·{" "}
                      {formatMoney(p.monthlyOut, fmt)}/mo
                    </span>
                  )}
                  {p.seed > 0 && (
                    <span className="text-foreground">
                      Start with {formatMoney(p.seed, fmt)}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function BalancesCard({ snap, sim, fmt }: Props) {
  const active = new Set([
    ...sim.events.flatMap((e) => [e.accountId, e.fromAccountId ?? e.accountId]),
    ...snap.variable.map((v) => v.accountId),
  ])
  const shown = snap.accounts
    .filter((a) => active.has(a.id))
    .sort(
      (a, b) =>
        Number(isCashAccount(b.type)) - Number(isCashAccount(a.type)) ||
        a.id - b.id
    )
    .slice(0, MAX_SERIES)
    .sort((a, b) => a.id - b.id)
  const series: Series[] = shown.map((a, i) => ({
    key: `a${a.id}`,
    label: a.name,
    color: SERIES_COLORS[i],
    values: sim.balances[a.id],
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account balances</CardTitle>
        <CardDescription title="Card repayments are transfers, so they aren't simulated.">
          Next {HORIZON_DAYS} days with the plan. Card repayments not included.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <TimelineChart days={sim.days} series={series} fmt={fmt} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {shown.map((a, i) => {
            const run = sim.balances[a.id]
            const lowest = Math.min(...run)
            const dips = lowest < 0 && isCashAccount(a.type)
            return (
              <div key={a.id} className="grid gap-1 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: SERIES_COLORS[i] }}
                  />
                  <span className="truncate font-medium" title={a.name}>
                    {a.name}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums">
                  <span className="text-sm text-muted-foreground">
                    {money(a.balance, fmt)}
                  </span>
                  <ArrowRightIcon className="size-3 text-muted-foreground" />
                  <span className="font-heading text-base font-semibold sm:text-lg">
                    {money(run[run.length - 1], fmt)}
                  </span>
                </div>
                <div
                  className={cn(
                    "text-xs tabular-nums",
                    dips ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {dips && <WarningCircleIcon className="mr-1 inline" />}
                  Lowest {money(lowest, fmt)}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

/** The family's goal in a line, for a person's own view. */
function FamilyGoalLine({ goal, fmt }: { goal: PlanGoal; fmt: MoneyFormat }) {
  const ahead = goal.gap >= 0
  return (
    <Link
      href="/plan?view=family"
      className="flex items-center gap-3 rounded-xl border px-4 py-3 text-sm text-pretty hover:bg-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">Family goal:</span> on course for{" "}
        {money(goal.forecast, fmt)} by {formatDate(goal.endDate, fmt.locale)},{" "}
        <span className={ahead ? "text-positive" : "text-destructive"}>
          {formatMoney(Math.abs(goal.gap), fmt)} {ahead ? "ahead" : "short"}
        </span>
        .
      </span>
      <CaretRightIcon className="shrink-0 text-muted-foreground" />
    </Link>
  )
}

/** A person's own accounts: now, and the lowest they get over the projection. */
function MyAccountsCard({ snap, sim, ids, fmt }: Props & { ids: Set<number> }) {
  const shown = snap.accounts.filter((a) => ids.has(a.id))
  if (shown.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your accounts</CardTitle>
        <CardDescription>
          Now, and the lowest each gets over the next {HORIZON_DAYS} days with
          the plan.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm">
          {shown.map((a) => {
            const run = sim.balances[a.id] ?? [a.balance]
            const lowest = Math.min(...run)
            const dips = lowest < 0 && isCashAccount(a.type)
            return (
              <li
                key={a.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b pb-2 last:border-b-0 last:pb-0"
              >
                <span className="truncate font-medium" title={a.name}>
                  {a.name}
                </span>
                <span className="font-medium tabular-nums">
                  {formatMoney(a.balance, fmt)}
                </span>
                <span
                  className={cn(
                    "col-span-2 text-xs tabular-nums",
                    dips ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  Lowest {formatMoney(lowest, fmt)}
                  {dips && " · will need topping up"}
                </span>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
