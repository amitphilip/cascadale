import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowDownLeftIcon,
  ArrowRightIcon,
  CaretRightIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  LightbulbIcon,
  PiggyBankIcon,
  SparkleIcon,
  UploadSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/ssr"

import { CategoryBreakdown, type CategoryCost } from "./category-breakdown"
import { NewPlanDialog } from "./new-plan-dialog"
import {
  AllocationCard,
  NetWorthCard,
  StandingCard,
  type Stat,
  UpcomingCard,
  VerdictCard,
  type Allocation,
} from "./plan-summary-cards"
import { RebuildButton, RemoveAdjustmentButton, RemovePotButton } from "./plan-instructions"
import { PlanAsk } from "./plan-ask"
import { type ChatMessage } from "./plan-chat"
import { PageHeader } from "@/components/page-header"
import { TimelineChart, type Series } from "@/components/plan-charts"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { formatDate, formatMoney, SERIES_COLORS, type MoneyFormat } from "@/lib/format"
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
import { isMaterialMove } from "@/lib/health"
import { buildNetWorth, monthEnds, netWorthHistory, pointBack } from "@/lib/net-worth"
import { planVerdict } from "@/lib/plan-verdict"
import { ACTOR_LABELS, type Actor } from "@/lib/plan-instructions"
import { getPlanState } from "@/lib/plan-service"
import { planDeps } from "@/lib/plan-repo"
import { latestPlan, loadSnapshot } from "@/lib/planner"
import {
  getAccountsWithBalances,
  getAssets,
  getPlanThread,
  getSettings,
  getTransactionAmounts,
} from "@/lib/queries"
import { CADENCE_LABELS } from "@/lib/recurring"
import { cn } from "@/lib/utils"
import { localDate } from "@/supabase/functions/_shared/akahu"

export const metadata: Metadata = { title: "Plan" }

/** Days of upcoming bills and paydays listed. */
const UPCOMING_DAYS = 14
/** Regular income smaller than this, such as bank interest, isn't worth a payday card. */
const MIN_PAYDAY = 50
/** Month-ends of net worth charted. */
const HISTORY_MONTHS = 12
/** How far back the verdict compares net worth and debts. */
const TREND_MONTHS = 3
/** Pots and accounts beyond this many share a neutral color, never a sixth hue. */
const MAX_SERIES = SERIES_COLORS.length
const OTHER_COLOR = "var(--muted-foreground)"
const SPEND_COLOR = "color-mix(in oklch, var(--muted-foreground) 45%, transparent)"
const LEFT_COLOR = "color-mix(in oklch, var(--muted-foreground) 18%, transparent)"

const PRIORITY_DOT = {
  high: "bg-destructive",
  medium: "bg-foreground/60",
  low: "bg-muted-foreground/50",
} as const

export default async function PlanPage() {
  const [fmt, thread, current, deps, accounts, assets, txs] = await Promise.all([
    getSettings(),
    getPlanThread(),
    loadSnapshot(),
    planDeps("website"),
    getAccountsWithBalances(),
    getAssets(),
    getTransactionAmounts(),
  ])

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
            <EmptyDescription>The planner needs a few months of transactions.</EmptyDescription>
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

  const plan = thread && latestPlan(thread.messages)
  // Out of date: instructions or Cas decisions not applied yet, new data, or balances that moved
  const moved = thread
    ? thread.snapshot.accounts.filter((a) => {
        const now = current.accounts.find((c) => c.id === a.id)
        return now && isMaterialMove(a.balance, now.balance)
      })
    : []
  const newData =
    thread && (thread.snapshot.dataEnd !== current.dataEnd || thread.snapshot.bills.length !== current.bills.length)
  const state = await getPlanState(deps, [
    ...(newData ? ["New transactions since this plan was built"] : []),
    ...(moved.length ? [`Balances moved since it was built: ${moved.map((a) => a.name).join(", ")}`] : []),
  ])

  if (!thread || !plan) {
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
              {current.incomes.length} regular {current.incomes.length === 1 ? "income" : "incomes"}{" "}
              · {current.bills.length} bills · {current.accounts.length} accounts
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              <NewPlanDialog trigger={<Button>Create a plan</Button>} />
              {state.pots.length > 0 && <RebuildButton planId={null} size="default" />}
            </div>
          </EmptyContent>
        </Empty>
      </>
    )
  }

  // today's data, not the snapshot the plan was built on, so nothing shown is in the past
  const snap = current
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
  const verdict = planVerdict({
    sim,
    warnings: state.status === "out_of_date" ? [] : plan.warnings,
    balanceOf: (id) => snap.accounts.find((a) => a.id === id)?.balance ?? 0,
    accountName: (id) => accountName(snap, id),
    trend: from ? { months: TREND_MONTHS, from, to: history[history.length - 1] } : null,
    money: (n) => formatMoney(n, fmt),
    date: (iso) => formatDate(iso, fmt.locale),
  })
  const cashNow = snap.accounts.filter((a) => isCashAccount(a.type))
  const lowestCash = Math.min(
    ...sim.days.map((_, i) => cashNow.reduce((s, a) => s + (sim.balances[a.id]?.[i] ?? a.balance), 0))
  )
  const netNow = history[history.length - 1].netWorth
  const stats: Stat[] = [
    {
      label: "Net worth",
      value: money(netNow, fmt),
      note: from ? `${formatMoney(netNow - from.netWorth, fmt, { signed: true })} in ${TREND_MONTHS} mo` : undefined,
      tone: from ? (netNow >= from.netWorth ? "good" : "bad") : undefined,
    },
    { label: "Cash now", value: money(cashNow.reduce((s, a) => s + a.balance, 0), fmt), note: `${cashNow.length} accounts` },
    { label: "Owed", value: money(-worth.totals.debts, fmt), note: `${worth.debts.length} cards and loans` },
    {
      label: "Lowest cash ahead",
      value: money(lowestCash, fmt),
      note: `next ${HORIZON_DAYS} days`,
      tone: lowestCash < 0 ? "bad" : undefined,
    },
    {
      label: "Left each month",
      value: money(sim.monthly.free, fmt),
      note: `of ${money(sim.monthly.income, fmt)} income`,
      tone: sim.monthly.free < 0 ? "bad" : "good",
    },
  ]
  const messages: ChatMessage[] = thread.messages.map((m, i) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    // the first reply is the plan itself, not a change to it
    changed: m.role === "assistant" && m.plan !== null && i > 1,
  }))

  return (
    <>
      <PageHeader
        title="Plan"
        description={`Data to ${formatDate(snap.dataEnd, fmt.locale)} · ${HORIZON_DAYS}-day projection${
          thread.madeBy ? ` · rebuilt by ${ACTOR_LABELS[thread.madeBy]}` : ""
        }`}
      >
        <NewPlanDialog
          trigger={
            <Button variant="outline" className="w-full sm:w-auto">
              <ClockCounterClockwiseIcon /> New plan
            </Button>
          }
        />
      </PageHeader>

      {state.status === "out_of_date" && (
        <Alert>
          <ClockCounterClockwiseIcon />
          <AlertTitle>This plan is out of date</AlertTitle>
          <AlertDescription>
            <p>{state.reasons.join(" · ")}</p>
            <ul className="grid gap-1">
              {state.pendingChanges.map((c) => (
                <li key={`c${c.id}`}>
                  • {c.summary ?? c.action} <span className="text-muted-foreground">({ACTOR_LABELS[c.actor]})</span>
                </li>
              ))}
              {state.unappliedDecisions.map((d) => (
                <li key={`d${d.id}`}>
                  • Decision: {d.content} <span className="text-muted-foreground">(Cas)</span>
                </li>
              ))}
            </ul>
            Rebuild to apply your pots and adjustments to today’s data, or start a new plan.
          </AlertDescription>
          <AlertAction>
            <RebuildButton planId={state.plan?.id ?? null} />
          </AlertAction>
        </Alert>
      )}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 gap-6">
          <StandingCard stats={stats} />

          <VerdictCard verdict={verdict} />

          <AllocationCard
            income={sim.monthly.income}
            rows={allocation(sim, colors, snap)}
            summary={state.status === "out_of_date" ? undefined : plan.summary}
            fmt={fmt}
          />

          <PaydayCards snap={snap} plan={plan} colors={colors} fmt={fmt} />

          <CategoryBreakdown
            threadId={thread.id}
            costs={categoryCosts(snap)}
            leftOver={sim.monthly.free}
            fmt={fmt}
          />

          <NetWorthCard history={history} owned={worth.owned} owed={worth.totals.debts} fmt={fmt} />

          <UpcomingCard
            events={sim.events.filter((e) => e.date <= sim.days[Math.min(UPCOMING_DAYS, sim.days.length) - 1])}
            days={UPCOMING_DAYS}
            accountName={(id) => accountName(snap, id)}
            fmt={fmt}
          />

          {state.status !== "out_of_date" && <FocusCards plan={plan} fmt={fmt} />}

          <details className="group grid gap-6">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-heading font-semibold">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              Pots, balances and adjustments
            </summary>
            <div className="mt-6 grid min-w-0 gap-6">
              <InstructionsCard state={state} snap={snap} fmt={fmt} />
              <PotsCard snap={snap} sim={sim} colors={colors} fmt={fmt} />
              <BalancesCard snap={snap} sim={sim} fmt={fmt} />
            </div>
          </details>
        </div>

        <PlanAsk threadId={thread.id} messages={messages} />
      </div>
      <div className="h-14 xl:hidden" aria-hidden />
    </>
  )
}

type Colors = Map<string, string>
type Props = { snap: PlanSnapshot; sim: Simulation; fmt: MoneyFormat }

function potColors(sim: Simulation): Colors {
  const ordered = [...sim.potSummaries].sort((a, b) => b.monthlyIn - a.monthlyIn)
  return new Map(ordered.map((p, i) => [p.name, SERIES_COLORS[i] ?? OTHER_COLOR]))
}

/** The month's income, pot by pot, then spending and what's left. */
function allocation(sim: Simulation, colors: Colors, snap: PlanSnapshot): Allocation[] {
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
    { key: "spend", label: "Day-to-day spending", color: SPEND_COLOR, value: sim.monthly.variable },
    { key: "left", label: "Left over", color: LEFT_COLOR, value: sim.monthly.free },
  ]
}

/** Monthly spending per expense category, biggest first. */
function categoryCosts(snap: PlanSnapshot): CategoryCost[] {
  const costs = new Map<string, CategoryCost>()
  const get = (category: string) => {
    const c = costs.get(category) ?? {
      category,
      bills: 0,
      dayToDay: 0,
      budget: snap.budgets.find((b) => b.category === category)?.budget ?? null,
    }
    costs.set(category, c)
    return c
  }
  for (const b of snap.bills) get(b.category).bills += b.monthly
  for (const v of snap.variable) get(v.category).dayToDay += v.monthly
  return [...costs.values()]
    .map((c) => ({ ...c, bills: Math.round(c.bills * 100) / 100, dayToDay: Math.round(c.dayToDay * 100) / 100 }))
    .filter((c) => c.bills + c.dayToDay >= 1)
    .sort((a, b) => b.bills + b.dayToDay - (a.bills + a.dayToDay))
}

const accountName = (snap: PlanSnapshot, id: number) =>
  snap.accounts.find((a) => a.id === id)?.name ?? "Unknown account"

const money = (n: number, fmt: MoneyFormat) => formatMoney(n, fmt, { compact: Math.abs(n) >= 10000 })

type Segment = { key: string; label: string; color: string; value: number }

function StackBar({ segments, fmt, className }: { segments: Segment[]; fmt: MoneyFormat; className?: string }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0)
  if (total <= 0) return null
  return (
    <div className={cn("flex h-4 w-full gap-0.5 overflow-hidden rounded-md", className)}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.key}
            className="h-full min-w-1 first:rounded-l-md last:rounded-r-md"
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
            title={`${s.label}: ${formatMoney(s.value, fmt)}`}
          />
        ))}
    </div>
  )
}

const ACTION_LABELS: Record<string, string> = {
  upsert_pot: "Pot",
  remove_pot: "Pot removed",
  add_plan_adjustment: "Adjustment",
  remove_plan_adjustment: "Adjustment removed",
  regenerate_plan: "Rebuilt",
}

/** Your pots, one-off adjustments and the latest changes to them, and who made each. */
function InstructionsCard({
  state,
  snap,
  fmt,
}: {
  state: Awaited<ReturnType<typeof getPlanState>>
  snap: PlanSnapshot
  fmt: MoneyFormat
}) {
  const { pots, adjustments, recentChanges } = state
  if (!pots.length && !adjustments.length && !recentChanges.length) return null
  const by = (actor: Actor, reason: string | null) =>
    `${ACTOR_LABELS[actor]}${reason ? ` · ${reason}` : ""}`
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your pots and adjustments</CardTitle>
        <CardDescription className="text-pretty">
          Set here or through Claude and Cas, and kept every time the plan is rebuilt.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm">
        {pots.length > 0 && (
          <ul className="grid gap-2">
            {pots.map((p) => (
              <li key={p.id} className="flex min-w-0 items-center gap-3">
                <PiggyBankIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {p.name} · {formatMoney(p.amount, fmt)} {FREQUENCY_TEXT[p.frequency]}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[
                      p.incomeName && `from ${p.incomeName}`,
                      p.fromAccountId && `out of ${accountName(snap, p.fromAccountId)}`,
                      p.toAccountId && `into ${accountName(snap, p.toAccountId)}`,
                      by(p.updatedBy, p.reason),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <RemovePotButton name={p.name} />
              </li>
            ))}
          </ul>
        )}
        {adjustments.length > 0 && (
          <ul className="grid gap-2">
            {adjustments.map((a) => {
              const label =
                a.kind === "skip"
                  ? `Skip ${a.name}`
                  : a.kind === "add"
                    ? `${a.name}: ${formatMoney(a.amount ?? 0, fmt)}`
                    : `${a.name} to ${formatMoney(a.amount ?? 0, fmt)}`
              return (
                <li key={a.id} className="flex min-w-0 items-center gap-3">
                  <Badge variant="secondary" className="shrink-0 tabular-nums">
                    {formatDate(a.date, fmt.locale)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{label}</div>
                    <div className="truncate text-xs text-muted-foreground">{by(a.createdBy, a.reason)}</div>
                  </div>
                  <RemoveAdjustmentButton id={a.id} label={label} />
                </li>
              )
            })}
          </ul>
        )}
        {recentChanges.length > 0 && (
          <div className="grid gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">Recent changes</div>
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {recentChanges.slice(0, 8).map((c) => (
                <li key={c.id} className="truncate">
                  {formatDate(localDate(c.createdAt), fmt.locale)} · {ACTOR_LABELS[c.actor]} ·{" "}
                  {c.summary ?? ACTION_LABELS[c.action] ?? c.action}
                  {c.reason ? ` · ${c.reason}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const FREQUENCY_TEXT = { payday: "every payday", fortnightly: "a fortnight", monthly: "a month" } as const

function FocusCards({ plan, fmt }: { plan: Plan; fmt: MoneyFormat }) {
  if (plan.focus.length === 0) return null
  return (
    <section className="grid gap-3">
      <h2 className="flex items-center gap-2 font-heading font-semibold">
        <LightbulbIcon /> Focus on
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plan.focus.map((f, i) => (
          <Card key={i} size="sm">
            <CardContent className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn("size-2 shrink-0 rounded-full", PRIORITY_DOT[f.priority])}
                  aria-hidden
                />
                <span className="text-xs text-muted-foreground capitalize">{f.priority} priority</span>
                {f.monthly_impact != null && f.monthly_impact !== 0 && (
                  <Badge variant="secondary" className="ml-auto shrink-0 tabular-nums">
                    ~{money(Math.abs(f.monthly_impact), fmt)}/mo
                  </Badge>
                )}
              </div>
              <div className="font-medium text-pretty">{f.title}</div>
              <p className="line-clamp-3 text-sm text-pretty text-muted-foreground" title={f.detail}>
                {f.detail}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

function PaydayCards({
  snap,
  plan,
  colors,
  fmt,
}: {
  snap: PlanSnapshot
  plan: Plan
  colors: Colors
  fmt: MoneyFormat
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
      { id: FORTNIGHTLY, name: "Every fortnight", when: "Fortnightly", amount: 0, accountId: null },
      { id: MONTHLY, name: "1st of the month", when: "Monthly", amount: 0, accountId: null },
    ].filter((src) => plan.set_asides.some((s) => s.income_id === src.id)),
  ]
  const funding = sources.filter(
    (src) => src.amount >= MIN_PAYDAY || plan.set_asides.some((s) => s.income_id === src.id)
  )
  return (
    <section className="grid gap-3">
      <h2 className="flex items-center gap-2 font-heading font-semibold">
        <ArrowDownLeftIcon /> On each payday, move
      </h2>
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
            ...(src.amount ? [{ key: "left", label: "Left to spend", color: LEFT_COLOR, value: left }] : []),
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
                      {src.accountId !== null && ` · into ${accountName(snap, src.accountId)}`}
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
                  <p className="text-sm text-muted-foreground">Nothing set aside from this income.</p>
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
                          style={{ backgroundColor: colors.get(e.pot) ?? OTHER_COLOR }}
                        />
                        <div className="min-w-0">
                          <div className="font-medium">{e.pot}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {e.to_account_id === null
                              ? "stays here"
                              : `to ${accountName(snap, e.to_account_id)}`}
                          </div>
                        </div>
                        <span className="font-medium tabular-nums">{formatMoney(e.amount, fmt)}</span>
                      </li>
                    ))}
                    {src.amount > 0 && (
                      <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 border-t pt-1.5 text-muted-foreground">
                        <span className="size-2.5 rounded-[3px]" style={{ backgroundColor: LEFT_COLOR }} />
                        Left to spend
                        <span className="tabular-nums">{formatMoney(left, fmt)}</span>
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
  const billName = (id: string) => snap.bills.find((b) => b.id === id)?.name ?? id

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBankIcon /> Pots
        </CardTitle>
        <CardDescription>Fills on payday, empties as bills go out.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <TimelineChart days={sim.days} series={series} fmt={fmt} step />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sim.potSummaries.map((p) => {
            const short = p.monthlyIn + 0.5 < p.monthlyOut
            const savings = p.covers.length === 0
            return (
              <div key={p.name} className="grid content-start gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: colors.get(p.name) }}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
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
                  <span className="text-xs font-normal text-muted-foreground"> /mo in</span>
                </div>
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span className="truncate">{accountName(snap, p.accountId)}</span>
                  {!savings && (
                    <span title={p.covers.map(billName).join(", ")}>
                      Pays {p.covers.length} {p.covers.length === 1 ? "bill" : "bills"} ·{" "}
                      {formatMoney(p.monthlyOut, fmt)}/mo
                    </span>
                  )}
                  {p.seed > 0 && (
                    <span className="text-foreground">Start with {formatMoney(p.seed, fmt)}</span>
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
    .sort((a, b) => Number(isCashAccount(b.type)) - Number(isCashAccount(a.type)) || a.id - b.id)
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
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: SERIES_COLORS[i] }} />
                  <span className="truncate font-medium" title={a.name}>
                    {a.name}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums">
                  <span className="text-sm text-muted-foreground">{money(a.balance, fmt)}</span>
                  <ArrowRightIcon className="size-3 text-muted-foreground" />
                  <span className="font-heading text-base font-semibold sm:text-lg">
                    {money(run[run.length - 1], fmt)}
                  </span>
                </div>
                <div className={cn("text-xs tabular-nums", dips ? "text-destructive" : "text-muted-foreground")}>
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
