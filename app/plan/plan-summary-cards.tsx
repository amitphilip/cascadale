import Link from "next/link"
import {
  ArrowDownLeftIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  TrendDownIcon,
  TrendUpIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/ssr"

import { TimelineChart } from "@/components/plan-charts"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import type { NetWorthPoint } from "@/lib/net-worth"
import type { ScheduledEvent } from "@/lib/plan"
import type { Verdict } from "@/lib/plan-verdict"
import { cn } from "@/lib/utils"

const GOOD = "text-positive"
const BAD = "text-destructive"

const TONE = {
  good: { card: "border-positive/40 bg-positive/5", text: GOOD, Icon: CheckCircleIcon },
  watch: { card: "", text: "text-foreground", Icon: WarningCircleIcon },
  bad: { card: "border-destructive/40 bg-destructive/5", text: BAD, Icon: WarningCircleIcon },
} as const

export type Stat = { label: string; value: string; note?: string; tone?: "good" | "bad" }

/** Where things stand today: the few numbers to check before reading the plan. */
export function StandingCard({ stats }: { stats: Stat[] }) {
  return (
    <section aria-label="Where you stand now" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {stats.map((s) => (
        <Card key={s.label} size="sm">
          <CardContent className="grid gap-0.5">
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div
              className={cn(
                "truncate font-heading text-xl font-semibold tabular-nums",
                s.tone === "good" && GOOD,
                s.tone === "bad" && BAD
              )}
            >
              {s.value}
            </div>
            {s.note && <div className="truncate text-xs text-muted-foreground tabular-nums">{s.note}</div>}
          </CardContent>
        </Card>
      ))}
    </section>
  )
}

/** The whole plan in one glance: how it stands, what's good and what isn't. */
export function VerdictCard({ verdict }: { verdict: Verdict }) {
  const { card, text, Icon } = TONE[verdict.tone]
  return (
    <Card className={card}>
      <CardHeader>
        <CardTitle className={cn("flex items-center gap-2 text-xl", text)}>
          <Icon className="size-6 shrink-0" /> {verdict.headline}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        <VerdictList title="Going well" items={verdict.good} Icon={CheckCircleIcon} color={GOOD} />
        <VerdictList title="Needs attention" items={verdict.bad} Icon={WarningCircleIcon} color={BAD} />
      </CardContent>
    </Card>
  )
}

function VerdictList({
  title,
  items,
  Icon,
  color,
}: {
  title: string
  items: string[]
  Icon: React.ComponentType<{ className?: string }>
  color: string
}) {
  return (
    <div className="grid content-start gap-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing right now.</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-pretty">
              <Icon className={cn("mt-0.5 size-4 shrink-0", color)} />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export type Allocation = { key: string; label: string; detail?: string; color: string; value: number }

/** Where each month's income goes, as shares of it. */
export function AllocationCard({
  income,
  rows,
  summary,
  fmt,
}: {
  income: number
  rows: Allocation[]
  summary?: string
  fmt: MoneyFormat
}) {
  const shown = rows.filter((r) => r.value > 0)
  const total = shown.reduce((s, r) => s + r.value, 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where {formatMoney(income, fmt)} of monthly income goes</CardTitle>
        {summary && <CardDescription className="text-pretty">{summary}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex h-8 w-full gap-0.5 overflow-hidden rounded-md">
          {shown.map((r) => (
            <div
              key={r.key}
              className="h-full min-w-1"
              style={{ width: `${(r.value / total) * 100}%`, backgroundColor: r.color }}
              title={`${r.label}: ${formatMoney(r.value, fmt)}`}
            />
          ))}
        </div>
        <ul className="grid gap-2.5 text-sm">
          {shown.map((r) => (
            <li key={r.key} className="grid grid-cols-[auto_minmax(0,1fr)_auto_3rem] items-center gap-x-2.5">
              <span className="size-3 rounded-[3px]" style={{ backgroundColor: r.color }} />
              <div className="min-w-0">
                <div className="truncate font-medium">{r.label}</div>
                {r.detail && <div className="truncate text-xs text-muted-foreground">{r.detail}</div>}
              </div>
              <span className="font-medium tabular-nums">{formatMoney(r.value, fmt)}</span>
              <span className="text-right text-muted-foreground tabular-nums">
                {income > 0 ? `${Math.round((r.value / income) * 100)}%` : ""}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** Net worth now, how it's moved, and the last year of it. */
export function NetWorthCard({
  history,
  owned,
  owed,
  fmt,
}: {
  history: NetWorthPoint[]
  owned: number
  owed: number
  fmt: MoneyFormat
}) {
  const latest = history[history.length - 1]
  const changes = [1, 3, 12].flatMap((months) => {
    const from = history[history.length - 1 - months]
    return from ? [{ months, change: latest.netWorth - from.netWorth }] : []
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          Net worth
          <Link
            href="/net-worth"
            className="flex items-center gap-1 text-sm font-normal text-muted-foreground hover:text-foreground"
          >
            Details <ArrowRightIcon className="size-3.5" />
          </Link>
        </CardTitle>
        <CardDescription className="text-pretty">
          Rebuilt from your transactions, with your assets at today’s value. Accounts connected
          recently only count from their first transaction.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <div className="font-heading text-3xl font-semibold tabular-nums">
              {formatMoney(latest.netWorth, fmt)}
            </div>
            <div className="text-sm text-muted-foreground tabular-nums">
              {formatMoney(owned, fmt)} owned · {formatMoney(-owed, fmt)} owed
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {changes.map(({ months, change }) => (
              <div key={months} className="rounded-lg border px-3 py-1.5">
                <div className="text-xs text-muted-foreground">
                  {months === 12 ? "1 year" : `${months} mo`}
                </div>
                <div
                  className={cn(
                    "flex items-center gap-1 text-sm font-medium tabular-nums",
                    change >= 0 ? GOOD : BAD
                  )}
                >
                  {change >= 0 ? <TrendUpIcon /> : <TrendDownIcon />}
                  {formatMoney(change, fmt, { signed: true })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <TimelineChart
          days={history.map((p) => p.date)}
          series={[
            {
              key: "netWorth",
              label: "Net worth",
              color: "var(--chart-1)",
              values: history.map((p) => p.netWorth),
            },
          ]}
          fmt={fmt}
          fitted
        />
      </CardContent>
    </Card>
  )
}

/** Money in and out over the next while, by day, without the moves between accounts. */
export function UpcomingCard({
  events,
  days,
  accountName,
  fmt,
}: {
  events: ScheduledEvent[]
  days: number
  accountName: (id: number) => string
  fmt: MoneyFormat
}) {
  const shown = events.filter((e) => e.kind !== "set-aside")
  const total = (kind: ScheduledEvent["kind"]) =>
    shown.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount, 0)
  const byDate = Map.groupBy(shown, (e) => e.date)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Next {days} days</CardTitle>
        <CardDescription className="tabular-nums">
          <span className={GOOD}>{formatMoney(total("income"), fmt)} coming in</span> ·{" "}
          {formatMoney(total("bill"), fmt)} going out
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {byDate.size === 0 && <p className="text-sm text-muted-foreground">Nothing scheduled.</p>}
        {[...byDate].map(([date, items]) => (
          <div key={date} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3">
            <div className="text-sm font-medium text-muted-foreground tabular-nums">
              {new Intl.DateTimeFormat(fmt.locale, { day: "numeric", month: "short" }).format(
                new Date(`${date}T00:00:00`)
              )}
            </div>
            <ul className="grid min-w-0 gap-1.5 text-sm">
              {items.map((e, i) => (
                <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2">
                  {e.kind === "income" ? (
                    <ArrowDownLeftIcon className={cn("shrink-0", GOOD)} aria-label="Income" />
                  ) : (
                    <ArrowUpRightIcon className="shrink-0 text-muted-foreground" aria-label="Bill" />
                  )}
                  <span className="flex min-w-0 items-center gap-2" title={`${e.name} · ${accountName(e.accountId)}`}>
                    <span className="truncate">{e.name}</span>
                    {e.oneOff && (
                      <Badge variant="secondary" className="shrink-0">
                        One-off
                      </Badge>
                    )}
                  </span>
                  <span className={cn("shrink-0 tabular-nums", e.kind === "income" && cn("font-medium", GOOD))}>
                    {formatMoney(e.kind === "income" ? e.amount : -e.amount, fmt, { signed: true })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
