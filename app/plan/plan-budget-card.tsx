import Link from "next/link"
import { CalendarCheckIcon, CaretRightIcon } from "@phosphor-icons/react/ssr"

import { ApplyAllBudgetsButton } from "@/app/recurring/budget-actions"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import type { BudgetLine, MonthBudget } from "@/lib/plan-budget"
import { cn } from "@/lib/utils"

/** Categories listed before the rest fold away. */
const SHOWN = 8

const GOOD = "text-positive"
const BAD = "text-destructive"

/**
 * This month so far: each category's spending against its budget (or the plan's amount
 * where it has none), with where an even pace would be by today, and the cash that's
 * genuinely spare.
 */
export function PlanBudgetCard({
  budget,
  spare,
  goalGap,
  budgets,
  fmt,
  title,
}: {
  /** e.g. "Your", before the month's name */
  title?: string
  budget: MonthBudget
  /** how far ahead of (or, negative, short of) the goal the plan is heading */
  goalGap: number
  /** cash you could spend today with every bill and set-aside still paid (lib/plan-budget) */
  spare: { amount: number; date: string } | null
  /** the plan's amounts as budgets, for setting them in one go */
  budgets: { categoryId: number; amount: number }[]
  fmt: MoneyFormat
}) {
  const money = (n: number) => formatMoney(n, fmt)
  // spare cash is only free to spend as far as the goal has room for it
  const free = spare ? Math.max(0, Math.min(spare.amount, goalGap)) : 0
  const lines = budget.lines
    .filter((l) => l.spent > 0 || l.limit > 0)
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) || b.spent / (b.limit || 1) - a.spent / (a.limit || 1)
    )
  const over = lines.filter((l) => l.status === "over" || l.status === "unplanned")
  const month = new Date(`${budget.month}-01T00:00:00`).toLocaleDateString(
    fmt.locale,
    { month: "long" }
  )

  return (
    <Card aria-labelledby="plan-month">
      <CardHeader>
        <CardTitle id="plan-month" className="flex items-center gap-2">
          <CalendarCheckIcon /> {title ? `${title} ${month}` : month} so far
        </CardTitle>
        <CardDescription className="text-pretty">
          Each category against its budget, or what the plan expects it to cost
          where it has none. The line marks where an even pace would be today.
        </CardDescription>
        {!budget.anyBudgets && budgets.length > 0 && (
          <CardAction>
            <ApplyAllBudgetsButton budgets={budgets} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Figure
            label="Spent"
            value={money(budget.spent)}
            note={`of ${money(budget.limit)} for the month`}
          />
          <Figure
            label="Left this month"
            value={money(budget.left)}
            note={`${budget.daysLeft} ${budget.daysLeft === 1 ? "day" : "days"} to go`}
            tone={budget.left < 0 ? BAD : undefined}
          />
          {spare && (
            <Figure
              className="col-span-2 sm:col-span-1"
              label="Free to spend"
              value={money(free)}
              note={
                goalGap < 0
                  ? `The cash is there (${money(spare.amount)}), but you’re ${money(-goalGap)} short of the goal, so anything extra pushes it further out`
                  : free < spare.amount
                    ? `Your margin over the goal; ${money(spare.amount)} in cash with every bill and pot paid to ${formatDate(spare.date, fmt.locale)}`
                    : `With every bill and pot paid to ${formatDate(spare.date, fmt.locale)}, still landing on the goal`
              }
              tone={free > 0 ? GOOD : BAD}
            />
          )}
        </div>

        {over.length > 0 && (
          <p className="text-sm text-pretty">
            <span className={cn("font-medium", BAD)}>
              {over.length === 1 ? "1 category is" : `${over.length} categories are`}{" "}
              over:
            </span>{" "}
            {over
              .map((l) => `${l.category} by ${money(l.spent - l.limit)}`)
              .join(", ")}
            .
          </p>
        )}

        <ul className="grid gap-3">
          {lines.slice(0, SHOWN).map((l) => (
            <Line key={l.category} line={l} pace={budget.pace} money={money} />
          ))}
        </ul>
        {lines.length > SHOWN && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              {lines.length - SHOWN} more categories
            </summary>
            <ul className="mt-3 grid gap-3">
              {lines.slice(SHOWN).map((l) => (
                <Line key={l.category} line={l} pace={budget.pace} money={money} />
              ))}
            </ul>
          </details>
        )}

        {budget.uncategorized > 0 && (
          <p className="text-xs text-muted-foreground">
            {money(budget.uncategorized)} this month isn’t categorized yet, so
            it’s not counted above.{" "}
            <Link href="/review" className="underline underline-offset-2">
              Review it
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** Over first, then running ahead, then the rest. */
const rank = (l: BudgetLine) =>
  ({ over: 0, unplanned: 0, ahead: 1, ok: 2 })[l.status]

function Line({
  line: l,
  pace,
  money,
}: {
  line: BudgetLine
  pace: number
  money: (n: number) => string
}) {
  const scale = Math.max(l.limit, l.spent, 1)
  const bad = l.status === "over" || l.status === "unplanned"
  return (
    <li className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="min-w-0 truncate font-medium" title={l.category}>
          {l.category}
        </span>
        <span className="tabular-nums">
          {money(l.spent)}
          {l.limit > 0 && (
            <span className="text-muted-foreground">
              {" "}
              of {money(l.limit)}
              {!l.fromBudget && " planned"}
            </span>
          )}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            bad ? "bg-destructive" : l.status === "ahead" ? "bg-destructive/60" : "bg-primary"
          )}
          style={{ width: `${Math.min(100, (l.spent / scale) * 100)}%` }}
        />
        {l.limit > 0 && pace < 1 && (
          <div
            className="absolute -top-0.5 h-3 w-0.5 rounded-full bg-foreground/60"
            style={{ left: `${(Math.min(l.expected, l.limit) / scale) * 100}%` }}
            title={`Even pace: ${money(l.expected)} by today`}
          />
        )}
      </div>
      <div
        className={cn(
          "text-xs tabular-nums",
          bad ? BAD : l.status === "ahead" ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {l.status === "unplanned"
          ? "Not in the plan"
          : l.status === "over"
            ? `${money(l.spent - l.limit)} over`
            : l.status === "ahead"
              ? `${money(l.left)} left · ahead of pace by ${money(l.spent - l.expected)}`
              : `${money(l.left)} left`}
      </div>
    </li>
  )
}

function Figure({
  label,
  value,
  note,
  tone,
  className,
}: {
  label: string
  value: string
  note: string
  tone?: string
  className?: string
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-0.5", className)}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn("truncate font-heading text-xl font-semibold tabular-nums", tone)}>
        {value}
      </div>
      <div className="text-xs text-pretty text-muted-foreground">{note}</div>
    </div>
  )
}
