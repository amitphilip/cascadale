"use client"

import { useState } from "react"
import {
  ArrowRightIcon,
  ChartBarHorizontalIcon,
  SparkleIcon,
} from "@phosphor-icons/react"

import { askPlanner } from "@/app/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import { cn } from "@/lib/utils"

/** One expense category's monthly cost in the plan's snapshot. */
export type CategoryCost = {
  category: string
  /** scheduled bills, per month */
  bills: number
  /** day-to-day spending, per month */
  dayToDay: number
  budget: number | null
}

/** Categories shown before "Show all". */
const SHOWN = 8
const BILLS_COLOR = "color-mix(in oklch, var(--foreground) 65%, transparent)"
const SPEND_COLOR =
  "color-mix(in oklch, var(--muted-foreground) 45%, transparent)"

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Monthly spending per category, with a what-if: type a new amount for any category to see
 * what it frees up (or costs), then ask the planner to rework the plan around it.
 */
export function CategoryBreakdown({
  threadId,
  costs,
  leftOver,
  fmt,
}: {
  threadId: number
  costs: CategoryCost[]
  leftOver: number
  fmt: MoneyFormat
}) {
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [showAll, setShowAll] = useState(false)
  const { pending, execute } = useServerAction()

  if (costs.length === 0) return null
  const money = (n: number) => formatMoney(n, fmt)
  const totalOf = (c: CategoryCost) => c.bills + c.dayToDay
  const spending = costs.reduce((s, c) => s + totalOf(c), 0)
  const largest = Math.max(...costs.map(totalOf))

  const changes = costs.flatMap((c) => {
    const raw = targets[c.category]?.trim()
    const to = raw ? Number(raw) : NaN
    if (!Number.isFinite(to) || to < 0) return []
    const delta = round(to - totalOf(c))
    return Math.abs(delta) >= 0.5
      ? [{ category: c.category, from: totalOf(c), to, delta }]
      : []
  })
  const change = changes.reduce((s, c) => s + c.delta, 0)
  // a changed category moves anything still fixed by the inputs, so keep it visible
  const shown = showAll
    ? costs
    : costs.filter((c, i) => i < SHOWN || targets[c.category]?.trim())

  function updatePlan() {
    const lines = changes.map(
      (c) =>
        `- ${c.category}: from ${money(c.from)} to ${money(c.to)} a month (${formatMoney(c.delta, fmt, { signed: true })})`
    )
    const message = `Please update the plan for these changes to my monthly spending:\n${lines.join("\n")}\nResize any pots whose bills change, and tell me what the difference means for what's left over.`
    execute(() => askPlanner(threadId, message), {
      success: (r) => (r.changed ? "Plan updated" : "Sent to the planner"),
      onSuccess: () => setTargets({}),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartBarHorizontalIcon /> Where your spending goes
        </CardTitle>
        <CardDescription className="text-pretty">
          {money(spending)} a month. Type a new amount for a category to see
          what it frees up.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ backgroundColor: BILLS_COLOR }}
            />{" "}
            Bills
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ backgroundColor: SPEND_COLOR }}
            />{" "}
            Day-to-day
          </span>
        </div>

        <ul className="grid gap-3">
          {shown.map((c) => {
            const total = totalOf(c)
            const over = c.budget !== null && total > c.budget + 0.5
            const share =
              spending > 0 ? Math.round((total / spending) * 100) : 0
            const id = `cat-${c.category.replace(/\W+/g, "-")}`
            return (
              <li
                key={c.category}
                className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-x-3 gap-y-1.5"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <label
                    htmlFor={id}
                    className="truncate font-medium"
                    title={c.category}
                  >
                    {c.category}
                  </label>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {share}%
                  </span>
                  <span className="ml-auto shrink-0 font-medium tabular-nums">
                    {money(total)}
                  </span>
                </div>
                <Input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  aria-label={`New monthly amount for ${c.category}`}
                  placeholder={String(Math.round(total))}
                  value={targets[c.category] ?? ""}
                  onChange={(e) =>
                    setTargets((t) => ({ ...t, [c.category]: e.target.value }))
                  }
                  disabled={pending}
                  className="row-span-2 h-8 text-right tabular-nums"
                />
                <div className="grid min-w-0 gap-1">
                  <div
                    className="flex h-2 gap-0.5 overflow-hidden rounded-full"
                    style={{
                      width: `${Math.max(2, (total / largest) * 100)}%`,
                    }}
                  >
                    {c.bills > 0 && (
                      <div
                        className="h-full"
                        style={{
                          width: `${(c.bills / total) * 100}%`,
                          backgroundColor: BILLS_COLOR,
                        }}
                      />
                    )}
                    {c.dayToDay > 0 && (
                      <div
                        className="h-full flex-1"
                        style={{ backgroundColor: SPEND_COLOR }}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                    {c.bills > 0 && <span>Bills {money(c.bills)}</span>}
                    {c.dayToDay > 0 && (
                      <span>Day-to-day {money(c.dayToDay)}</span>
                    )}
                    {c.budget !== null && (
                      <span className={cn(over && "text-destructive")}>
                        Budget {money(c.budget)}
                        {over && ` · ${money(total - c.budget)} over`}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        {costs.length > SHOWN && (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? "Show fewer" : `Show all ${costs.length} categories`}
          </Button>
        )}

        {changes.length > 0 && (
          <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm tabular-nums">
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Spending</span>
                {money(spending)}{" "}
                <ArrowRightIcon className="size-3 text-muted-foreground" />
                <span className="font-medium">{money(spending + change)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Left over</span>
                {money(leftOver)}{" "}
                <ArrowRightIcon className="size-3 text-muted-foreground" />
                <span
                  className={cn(
                    "font-medium",
                    leftOver - change < 0
                      ? "text-destructive"
                      : "text-foreground"
                  )}
                >
                  {money(leftOver - change)}
                </span>
              </span>
              <Badge variant={change > 0 ? "destructive" : "secondary"}>
                {formatMoney(-change, fmt, { signed: true })}/mo
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={updatePlan} disabled={pending}>
                <SparkleIcon data-icon="inline-start" />
                {pending
                  ? "Updating… this can take a minute"
                  : "Update the plan"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTargets({})}
                disabled={pending}
              >
                Reset
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
