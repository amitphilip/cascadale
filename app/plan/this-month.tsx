import Link from "next/link"
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CaretRightIcon,
  CoinsIcon,
  GaugeIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/ssr"

import { StatusBadge } from "@/app/check-in-view"
import { ApplyAllBudgetsButton } from "@/app/recurring/budget-actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import type {
  BudgetPeriodView,
  BudgetRow,
  BudgetsNow,
  MonthInOut,
  MonthItem,
  PotMonth,
} from "@/lib/plan-month"
import type { Standing } from "@/lib/plan-verdict"
import { cn } from "@/lib/utils"

// The front of the Plan page: this month's in and out, the budgets and the pots. The
// full plan sits behind it, in the accountant's view, and Cas keeps it in step.

const GOOD = "text-positive"
const BAD = "text-destructive"
const FULL_PLAN = "/plan?view=accountant"

const shortDate = (iso: string, locale: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(y, m - 1, d))
}

const monthName = (ym: string, locale: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString(locale, { month: "long" })

/** Where the plan stands, in a line, with what Cas is keeping in step behind it. */
export function CasLine({
  standing,
  waiting,
  todo,
}: {
  standing: Standing
  /** Cas's decisions not yet carried into the plan */
  waiting: number
  /** open action items */
  todo: number
}) {
  const extras = [
    todo > 0 && `${todo} to do`,
    waiting > 0 && `${waiting} ${waiting === 1 ? "change" : "changes"} waiting`,
  ].filter(Boolean)
  return (
    <Link
      href={FULL_PLAN}
      className="flex items-center gap-3 rounded-xl border px-4 py-3 text-sm hover:bg-accent"
    >
      <StatusBadge status={standing.status} />
      <span className="min-w-0 flex-1 text-pretty">
        <span className="font-medium">{standing.headline}</span>
        <span className="block text-xs text-muted-foreground">
          Cas keeps the full plan in step with your accounts
          {extras.length > 0 && ` · ${extras.join(" · ")}`}
        </span>
      </span>
      <CaretRightIcon className="shrink-0 text-muted-foreground" />
    </Link>
  )
}

/** This month's money in and out: so far, still to come with the plan, and where it ends up. */
export function InOutCard({
  inOut,
  fmt,
  title,
  stale,
}: {
  inOut: MonthInOut
  fmt: MoneyFormat
  /** e.g. "Your", before the month's name */
  title?: string
  /** the last transaction is a few days back, so "so far" may be missing some */
  stale?: string | null
}) {
  const money = (n: number) => formatMoney(n, fmt)
  const month = monthName(inOut.month, fmt.locale)
  const items = [
    ...inOut.in.items.map((i) => ({ ...i, sign: 1 as const })),
    ...inOut.out.items.map((i) => ({ ...i, sign: -1 as const })),
  ].sort((a, b) => a.date.localeCompare(b.date) || b.sign - a.sign)
  const ahead = inOut.net >= 0

  return (
    <Card aria-labelledby="plan-in-out">
      <CardHeader>
        <CardTitle id="plan-in-out">
          {title ? `${title} ${month}` : month}: in and out
        </CardTitle>
        <CardDescription className="text-pretty">
          What&rsquo;s come in and gone out so far, and what the plan still
          expects before the month ends. Transfers between your accounts
          aren&rsquo;t counted.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Side
            label="Money in"
            Icon={ArrowDownLeftIcon}
            total={inOut.in.expected}
            parts={[
              { label: "Received", value: inOut.in.received, solid: true },
              { label: "Still to come", value: inOut.in.toCome },
            ]}
            tone="bg-positive"
            money={money}
          />
          <Side
            label="Money out"
            Icon={ArrowUpRightIcon}
            total={inOut.out.expected}
            parts={[
              { label: "Spent", value: inOut.out.spent, solid: true },
              { label: "Bills to come", value: inOut.out.billsToCome },
              {
                label: "Day-to-day to come",
                value: inOut.out.dayToDayToCome,
              },
            ]}
            tone="bg-foreground/70"
            money={money}
          />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t pt-4">
          <span className="text-sm text-muted-foreground">
            {ahead ? "Left over" : "Short"} by the end of {month}
          </span>
          <span
            className={cn(
              "font-heading text-xl font-semibold tabular-nums",
              ahead ? GOOD : BAD
            )}
          >
            {formatMoney(inOut.net, fmt, { signed: true })}
          </span>
        </div>

        {stale && (
          <p className="text-xs text-pretty text-muted-foreground">
            <WarningCircleIcon className="mr-1 inline" />
            Transactions run to {stale}, so &ldquo;so far&rdquo; may be missing
            the last few days.
          </p>
        )}

        {items.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              Still to come this month ({items.length})
            </summary>
            <ul className="mt-3 grid gap-2 text-sm">
              {items.map((i, k) => (
                <ItemLine key={k} item={i} sign={i.sign} fmt={fmt} />
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

function Side({
  label,
  Icon,
  total,
  parts,
  tone,
  money,
}: {
  label: string
  Icon: React.ComponentType<{ className?: string }>
  total: number
  parts: { label: string; value: number; solid?: boolean }[]
  /** the bar's colour */
  tone: string
  money: (n: number) => string
}) {
  const sum = parts.reduce((s, p) => s + Math.max(0, p.value), 0)
  return (
    <div className="grid min-w-0 content-start gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon /> {label}
      </div>
      <div className="font-heading text-2xl font-semibold tabular-nums">
        {money(total)}
      </div>
      {sum > 0 && (
        <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
          {parts
            .filter((p) => p.value > 0)
            .map((p, i) => (
              <div
                key={p.label}
                className={cn(
                  "h-full min-w-1",
                  tone,
                  !p.solid && (i === 1 ? "opacity-45" : "opacity-25")
                )}
                style={{ width: `${(p.value / sum) * 100}%` }}
                title={`${p.label}: ${money(p.value)}`}
              />
            ))}
        </div>
      )}
      <ul className="grid gap-1 text-sm">
        {parts.map((p) => (
          <li key={p.label} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{p.label}</span>
            <span className={cn("tabular-nums", p.solid && "font-medium")}>
              {money(p.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ItemLine({
  item,
  sign,
  fmt,
}: {
  item: MonthItem
  sign: 1 | -1
  fmt: MoneyFormat
}) {
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        {shortDate(item.date, fmt.locale)}
      </span>
      <span className="min-w-0 truncate" title={item.name}>
        {item.name}
        {(item.pot || item.oneOff) && (
          <span className="text-xs text-muted-foreground">
            {" "}
            · {item.pot ? `from ${item.pot}` : "one-off"}
          </span>
        )}
      </span>
      <span className={cn("tabular-nums", sign > 0 && GOOD)}>
        {formatMoney(sign * item.amount, fmt, { signed: true })}
      </span>
    </li>
  )
}

/** Every weekly and monthly budget against this week's or this month's spending. */
export function BudgetsCard({
  budgets,
  planned,
  fmt,
}: {
  budgets: BudgetsNow
  /** the plan's monthly amounts, to set as budgets in one go when there are none */
  planned: { categoryId: number; amount: number }[]
  fmt: MoneyFormat
}) {
  const money = (n: number) => formatMoney(n, fmt)
  const week = `${shortDate(budgets.week.start, fmt.locale)} – ${shortDate(
    lastDay(budgets.week.end),
    fmt.locale
  )}`
  const month = monthName(budgets.month.start.slice(0, 7), fmt.locale)

  return (
    <Card aria-labelledby="plan-budgets">
      <CardHeader>
        <CardTitle id="plan-budgets" className="flex items-center gap-2">
          <GaugeIcon /> Budgets
        </CardTitle>
        <CardDescription className="text-pretty">
          Weekly budgets run Monday to Sunday. The line marks where an even pace
          would be today.
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href="/categories" />}
          >
            Edit budgets
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-6">
        {!budgets.anyBudgets ? (
          <div className="grid gap-3 rounded-lg border border-dashed p-4 text-sm">
            <p className="text-pretty text-muted-foreground">
              No budgets set yet. Give a category a weekly or monthly budget on
              the Categories page, ask Cas to set them, or start from what the
              plan expects each category to cost.
            </p>
            {planned.length > 0 && (
              <div>
                <ApplyAllBudgetsButton budgets={planned} />
              </div>
            )}
          </div>
        ) : (
          <>
            {budgets.week.rows.length > 0 && (
              <PeriodSection
                title="This week"
                range={week}
                view={budgets.week}
                money={money}
              />
            )}
            {budgets.month.rows.length > 0 && (
              <PeriodSection
                title={`This month`}
                range={month}
                view={budgets.month}
                money={money}
              />
            )}
          </>
        )}

        {budgets.unbudgeted.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 text-sm">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              <span className="font-medium">Not budgeted</span>
              <span className="text-muted-foreground tabular-nums">
                {money(budgets.unbudgetedTotal)} this month across{" "}
                {budgets.unbudgeted.length}{" "}
                {budgets.unbudgeted.length === 1 ? "category" : "categories"}
              </span>
            </summary>
            <ul className="mt-3 grid gap-1.5 text-sm">
              {budgets.unbudgeted.map((u) => (
                <li key={u.category} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate" title={u.category}>
                    {u.category}
                  </span>
                  <span className="tabular-nums">{money(u.spent)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {budgets.uncategorized > 0 && (
          <p className="text-xs text-muted-foreground">
            {money(budgets.uncategorized)} this month isn&rsquo;t categorised
            yet, so it&rsquo;s not counted above.{" "}
            <Link href="/review" className="underline underline-offset-2">
              Review it
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** The day before an exclusive end date. */
function lastDay(end: string) {
  const [y, m, d] = end.split("-").map(Number)
  const day = new Date(y, m - 1, d - 1)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
}

function PeriodSection({
  title,
  range,
  view,
  money,
}: {
  title: string
  range: string
  view: BudgetPeriodView
  money: (n: number) => string
}) {
  const over = view.left < 0
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="font-heading text-sm font-semibold">
          {title}{" "}
          <span className="font-normal text-muted-foreground">· {range}</span>
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {money(view.spent)} of {money(view.budget)} ·{" "}
          <span className={over ? BAD : undefined}>
            {over
              ? `${money(-view.left)} over`
              : `${money(view.left)} left`}
          </span>{" "}
          · {view.daysLeft} {view.daysLeft === 1 ? "day" : "days"} to go
        </span>
      </div>
      <ul className="grid gap-3">
        {view.rows.map((r) => (
          <BudgetLine key={r.categoryId} row={r} pace={view.pace} money={money} />
        ))}
      </ul>
    </section>
  )
}

function BudgetLine({
  row: r,
  pace,
  money,
}: {
  row: BudgetRow
  pace: number
  money: (n: number) => string
}) {
  const scale = Math.max(r.amount, r.spent, 1)
  const over = r.status === "over"
  return (
    <li className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="min-w-0 truncate font-medium" title={r.category}>
          {r.category}
        </span>
        <span className="tabular-nums">
          {money(r.spent)}
          <span className="text-muted-foreground"> of {money(r.amount)}</span>
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            over
              ? "bg-destructive"
              : r.status === "ahead"
                ? "bg-destructive/60"
                : "bg-primary"
          )}
          style={{ width: `${Math.min(100, (r.spent / scale) * 100)}%` }}
        />
        {pace < 1 && (
          <div
            className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-foreground/60"
            style={{ left: `${(r.expected / scale) * 100}%` }}
            title={`Even pace: ${money(r.expected)} by today`}
          />
        )}
      </div>
      <div
        className={cn(
          "text-xs tabular-nums",
          over
            ? BAD
            : r.status === "ahead"
              ? "text-foreground"
              : "text-muted-foreground"
        )}
      >
        {over
          ? `${money(-r.left)} over`
          : r.status === "ahead"
            ? `${money(r.left)} left · ahead of pace by ${money(r.spent - r.expected)}`
            : `${money(r.left)} left`}
      </div>
    </li>
  )
}

/** Each sinking fund's month: in and out so far, what's still to come, and its balance. */
export function PotsMonthCard({
  pots,
  fmt,
}: {
  pots: PotMonth[]
  fmt: MoneyFormat
}) {
  const money = (n: number) => formatMoney(n, fmt)
  const live = pots.filter((p) => !p.ended)
  return (
    <Card aria-labelledby="plan-pots">
      <CardHeader>
        <CardTitle id="plan-pots" className="flex items-center gap-2">
          <CoinsIcon /> Pots
        </CardTitle>
        <CardDescription className="text-pretty">
          Money put by for one-off and lumpy costs, with what went in and came
          out this month.
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`${FULL_PLAN}#funds`} />}
          >
            Manage
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {live.length === 0 ? (
          <p className="text-sm text-pretty text-muted-foreground">
            No pots yet. Make one for a cost such as air tickets, a holiday or
            an invoice in the full plan, or ask Cas to set one up.
          </p>
        ) : (
          live.map((p) => <PotRow key={p.id} pot={p} fmt={fmt} money={money} />)
        )}
      </CardContent>
    </Card>
  )
}

function PotRow({
  pot: p,
  fmt,
  money,
}: {
  pot: PotMonth
  fmt: MoneyFormat
  money: (n: number) => string
}) {
  const short = p.shortfall > 0
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium" title={p.name}>
              {p.name}
            </span>
            {short && (
              <Badge variant="destructive">
                <WarningCircleIcon /> {money(p.shortfall)} short
              </Badge>
            )}
          </div>
          {p.nextDraw && (
            <div className="text-xs text-muted-foreground">
              Next: {p.nextDraw.name}, {money(p.nextDraw.amount)} on{" "}
              {shortDate(p.nextDraw.date, fmt.locale)}
            </div>
          )}
          {p.cap && (
            <div className="text-xs text-muted-foreground tabular-nums">
              {money(p.cap.remaining)} of {money(p.cap.amount)} cap left
            </div>
          )}
        </div>
        <div className="shrink-0 font-heading text-lg font-semibold tabular-nums">
          {money(p.balance)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Flow
          label="In this month"
          value={p.in}
          toCome={p.inToCome}
          toComeLabel="to come"
          tone={GOOD}
          sign={1}
          fmt={fmt}
        />
        <Flow
          label="Out this month"
          value={p.out}
          toCome={p.outToCome}
          toComeLabel="planned"
          sign={-1}
          fmt={fmt}
        />
      </div>
      {p.alerts.length > 0 && (
        <ul className="grid gap-0.5 text-xs text-destructive">
          {p.alerts.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Flow({
  label,
  value,
  toCome,
  toComeLabel,
  tone,
  sign,
  fmt,
}: {
  label: string
  value: number
  toCome: number
  toComeLabel: string
  tone?: string
  sign: 1 | -1
  fmt: MoneyFormat
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", value > 0 && tone)}>
        {formatMoney(sign * value, fmt, { signed: true })}
      </span>
      {toCome > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatMoney(sign * toCome, fmt, { signed: true })} {toComeLabel}
        </span>
      )}
    </div>
  )
}

/** The way through to the full plan, which Cas keeps in step. */
export function FullPlanLink() {
  return (
    <Link
      href={FULL_PLAN}
      className="flex items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm hover:bg-accent"
    >
      <SparkleIcon className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-pretty">
        <span className="font-medium">The full plan</span>
        <span className="block text-xs text-muted-foreground">
          The goal, what to move on each payday, pots, to-dos, the projection
          and what Cas has changed. Cas keeps it in sync.
        </span>
      </span>
      <CaretRightIcon className="shrink-0 text-muted-foreground" />
    </Link>
  )
}
