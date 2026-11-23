import Link from "next/link"
import { CaretRightIcon } from "@phosphor-icons/react/ssr"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { PACE_LABELS, type BudgetTrack, type Pace } from "@/lib/budget-tracking"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import { cn } from "@/lib/utils"

// How each budget is doing so far, against its own week or month. Each row opens the
// budget's line in the table below.

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
  fmt,
}: {
  budgets: BudgetTrack[]
  /** e.g. "Week of 16 Nov" */
  weekLabel: string
  monthLabel: string
  fmt: MoneyFormat
}) {
  if (budgets.length === 0) return null
  const over = budgets.filter((b) => b.pace === "over").length
  return (
    <Card className="max-sm:[--card-spacing:--spacing(4)]">
      <CardHeader>
        <CardTitle>So far</CardTitle>
        <CardDescription>
          {over > 0 ? `${over} over budget. ` : ""}
          The whole household&rsquo;s spending. Weekly budgets run Monday to Sunday.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <ul className="grid grid-cols-1">
          {budgets.map((b) => (
            <li key={b.id} className="border-t first:border-t-0">
              <Link
                href={`/plan/budgets#budget-${b.id}`}
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
      </CardContent>
    </Card>
  )
}
