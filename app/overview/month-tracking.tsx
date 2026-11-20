import Link from "next/link"
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CaretRightIcon,
} from "@phosphor-icons/react/ssr"

import { PACE_LABELS, type BudgetTrack, type Pace } from "@/lib/budget-tracking"
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
import { Progress } from "@/components/ui/progress"
import type { OneOff } from "@/lib/db/schema"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import type { OneOffPlan, OneOffStatus } from "@/lib/one-offs"
import { cn } from "@/lib/utils"

// The top of the Overview: this month's money in and out, budgets against their week or
// month, and the one-off payments being saved for. Each card is a stacked list that reads
// at phone width.

/** Money in and out so far this month, and what's left. */
export function ThisMonthCard({
  income,
  expense,
  monthLabel,
  scope,
  fmt,
}: {
  income: number
  expense: number
  /** e.g. "1–18 November" */
  monthLabel: string
  /** e.g. "from your accounts" or "the whole household" */
  scope: string
  fmt: MoneyFormat
}) {
  const net = income - expense
  return (
    <Card>
      <CardHeader>
        <CardTitle>This month</CardTitle>
        <CardDescription>
          {monthLabel}, {scope}. Transfers between your accounts are left out.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Figure
            label="Money in"
            value={formatMoney(income, fmt)}
            icon={<ArrowDownIcon className="text-emerald-600 dark:text-emerald-400" />}
          />
          <Figure
            label="Money out"
            value={formatMoney(expense, fmt)}
            icon={<ArrowUpIcon className="text-destructive" />}
          />
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t pt-3 text-sm">
          <span className="text-muted-foreground">{net >= 0 ? "Left over so far" : "Spent more than came in"}</span>
          <span className={cn("text-base font-semibold tabular-nums", net < 0 && "text-destructive")}>
            {formatMoney(net, fmt, { signed: true })}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function Figure({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 rounded-lg border p-3">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="font-heading text-lg font-semibold break-words tabular-nums sm:text-2xl">{value}</span>
    </div>
  )
}

const PACE_TONE: Record<Pace, string> = {
  over: "text-destructive",
  ahead: "text-amber-700 dark:text-amber-400",
  on_pace: "text-muted-foreground",
}

/** Each budget against its week or month, with what's left and how the pace is going. */
export function BudgetTrackingCard({
  budgets,
  weekLabel,
  monthLabel,
  scope,
  fmt,
}: {
  budgets: BudgetTrack[]
  /** e.g. "Week of 16 Nov" */
  weekLabel: string
  monthLabel: string
  /** null for the household; "from your accounts" in someone's own view */
  scope: string | null
  fmt: MoneyFormat
}) {
  const over = budgets.filter((b) => b.pace === "over").length
  return (
    <Card>
      <CardHeader>
        <CardTitle>Budgets</CardTitle>
        <CardDescription>
          {budgets.length === 0
            ? "Nothing to track yet."
            : over > 0
              ? `${over} over budget. Weekly budgets run Monday to Sunday.`
              : "Weekly budgets run Monday to Sunday."}
          {scope && ` Spending ${scope}.`}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/recurring" />}>
            Edit
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {budgets.length === 0 ? (
          <p className="px-(--card-spacing) text-sm text-muted-foreground">
            Set budgets on{" "}
            <Link href="/recurring" className="underline underline-offset-4">
              Recurring &amp; budget
            </Link>
            , as an amount or a % of income, to track them here.
          </p>
        ) : (
          <ul className="grid grid-cols-1">
            {budgets.map((b) => (
              <li key={b.id} className="border-t first:border-t-0">
                <Link
                  href={`/recurring#budget-${b.id}`}
                  className="grid min-h-14 grid-cols-1 gap-1.5 px-(--card-spacing) py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  aria-label={`${b.name}: ${formatMoney(b.spent, fmt)} of ${formatMoney(b.budget, fmt)} this ${b.period}, ${PACE_LABELS[b.pace].toLowerCase()}. Edit budget`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{b.name}</span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {formatMoney(b.spent, fmt)}
                      <span className="text-muted-foreground"> / {formatMoney(b.budget, fmt)}</span>
                    </span>
                  </div>
                  <Progress
                    value={Math.min(b.spent / b.budget, 1) * 100}
                    className={cn(
                      b.pace === "over" && "[&_[data-slot=progress-indicator]]:bg-destructive",
                      b.pace === "ahead" && "[&_[data-slot=progress-indicator]]:bg-amber-500"
                    )}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs">
                    <span className="text-muted-foreground">
                      {b.period === "week" ? weekLabel : monthLabel}
                      {b.percent !== null && ` · ${b.percent}% of income`}
                    </span>
                    <span className={cn("flex items-center gap-1", PACE_TONE[b.pace])}>
                      {PACE_LABELS[b.pace]} ·{" "}
                      {b.left >= 0 ? `${formatMoney(b.left, fmt)} left` : `${formatMoney(-b.left, fmt)} over`}
                      <CaretRightIcon className="text-muted-foreground" aria-hidden />
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

const ONE_OFF_STATUS: Record<
  Exclude<OneOffStatus, "paid">,
  { label: string; variant: "outline" | "destructive" }
> = {
  on_track: { label: "On track", variant: "outline" },
  catch_up: { label: "Needs money now", variant: "destructive" },
  overdue: { label: "Overdue", variant: "destructive" },
}

/** One-off payments still to pay: how much is put aside, and the next move. */
export function OneOffTrackingCard({
  items,
  accountName,
  scope,
  fmt,
}: {
  items: { oneOff: OneOff; plan: OneOffPlan }[]
  accountName: (id: number) => string
  /** null for the household; set in someone's own view */
  scope: string | null
  fmt: MoneyFormat
}) {
  const open = items.filter((i) => i.plan.status !== "paid")
  return (
    <Card>
      <CardHeader>
        <CardTitle>One-off payments</CardTitle>
        <CardDescription>
          {open.length === 0
            ? "Nothing being saved for right now."
            : "What's put aside for each, and what's next."}
          {scope && ` ${scope}.`}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/one-offs" />}>
            All
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {open.length === 0 ? (
          <p className="px-(--card-spacing) text-sm text-muted-foreground">
            Add a known cost coming up, like rego, a trip or school fees, on{" "}
            <Link href="/one-offs" className="underline underline-offset-4">
              One-off payments
            </Link>{" "}
            to save for it in steps.
          </p>
        ) : (
          <ul className="grid grid-cols-1">
            {open.map(({ oneOff: o, plan }) => {
              const status = ONE_OFF_STATUS[plan.status as Exclude<OneOffStatus, "paid">]
              const next = plan.moves[0]
              return (
                <li key={o.id} className="border-t first:border-t-0">
                  <Link
                    href="/one-offs"
                    className="grid min-h-14 grid-cols-1 gap-1.5 px-(--card-spacing) py-3 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium" title={o.name}>{o.name}</div>
                        <div className="text-xs text-muted-foreground">
                          By {formatDate(o.finishDate, fmt.locale)} · {accountName(o.accountId)}
                        </div>
                      </div>
                      <Badge variant={status.variant} className="shrink-0">
                        {status.label}
                      </Badge>
                    </div>
                    <Progress
                      value={plan.progress * 100}
                      aria-label={`${o.name}: ${Math.round(plan.progress * 100)}% put aside or paid`}
                    />
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                      <span className="tabular-nums">
                        {formatMoney(plan.held + plan.paidOut, fmt)}
                        <span className="text-muted-foreground"> of {formatMoney(o.total, fmt)}</span>
                      </span>
                      {next && (
                        <span className={cn("tabular-nums", next.now ? "text-destructive" : "text-muted-foreground")}>
                          {next.kind === "in" ? "Put in " : "Pay "}
                          {formatMoney(next.amount, fmt)}{" "}
                          {next.now ? "now" : `on ${formatDate(next.date, fmt.locale)}`}
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
