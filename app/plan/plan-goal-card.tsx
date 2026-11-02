import { CaretRightIcon, FlagIcon } from "@phosphor-icons/react/ssr"

import { StatusBadge } from "@/app/check-in-view"
import { TimelineChart, type Series } from "@/components/plan-charts"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatDate, formatMoney, SERIES_COLORS, type MoneyFormat } from "@/lib/format"
import type { GoalDay, PlanGoal, Split } from "@/lib/plan-goal"
import { cn } from "@/lib/utils"

/** Days with data listed before the rest fold away. */
const RECENT_DAYS = 7

const GOOD = "text-positive"
const BAD = "text-destructive"

/**
 * The plan in one place: what it's for, the goal it lands on, and how you're tracking
 * against it day by day.
 */
export function PlanGoalCard({
  summary,
  goal,
  fmt,
}: {
  /** the plan's idea, in a sentence */
  summary: string
  goal: PlanGoal
  fmt: MoneyFormat
}) {
  const money = (n: number, signed = false) =>
    formatMoney(n, fmt, { signed, compact: Math.abs(n) >= 100000 })
  const date = (iso: string) => formatDate(iso, fmt.locale)
  const ahead = goal.gap >= 0
  const series: Series[] = [
    {
      key: "planned",
      label: "Plan (net)",
      color: "var(--muted-foreground)",
      values: goal.days.map((d) => d.planned),
    },
    {
      key: "actual",
      label: "Actual (net)",
      color: SERIES_COLORS[0],
      values: goal.days.map((d) => d.actual),
    },
    {
      key: "forecast",
      label: "Heading for",
      color: SERIES_COLORS[0],
      values: goal.days.map((d) => d.forecast),
      dashed: true,
    },
  ]
  // newest first, each with how much the balance moved that day
  const tracked = goal.days
    .map((d, i) => ({ ...d, prev: goal.days[i - 1]?.actual ?? null }))
    .filter((d): d is GoalDay & { actual: number; prev: number | null } => d.actual !== null)
    .reverse()

  return (
    <Card aria-labelledby="plan-goal">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusBadge status={goal.tone} />
          <span>
            Goal set {date(goal.startedOn)} · ends {date(goal.endDate)}
          </span>
        </div>
        <CardTitle id="plan-goal" className="text-xl text-balance">
          {summary}
        </CardTitle>
        <CardDescription className="text-pretty">
          Tracked as your net position: cash less what you owe on cards and
          revolving credit, home loans left out. Days will drift from the plan;
          Cas checks in against the goal and adjusts the plan to still land on
          it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Figure
            label={
              <>
                <FlagIcon className="inline" /> Goal by {date(goal.endDate)}
              </>
            }
            value={money(goal.target)}
            parts={goal.targetSplit}
            money={money}
          />
          <Figure
            label="Heading for"
            value={money(goal.forecast)}
            note={`${money(Math.abs(goal.gap))} ${ahead ? "ahead" : "short"}`}
            tone={ahead ? GOOD : BAD}
            parts={goal.forecastSplit}
            money={money}
          />
          {goal.latest && (
            <Figure
              className="col-span-2 sm:col-span-1"
              label={`${date(goal.latest.date)}, latest`}
              value={money(goal.latest.actual)}
              note={`${money(goal.latest.actual - goal.latest.planned, true)} against the plan`}
              tone={goal.latest.actual >= goal.latest.planned ? GOOD : BAD}
              parts={goal.latest}
              money={money}
            />
          )}
        </div>

        <TimelineChart
          days={goal.days.map((d) => d.date)}
          series={series}
          fmt={fmt}
          fitted
        />

        {tracked.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Day by day
            </h3>
            <DayList days={tracked.slice(0, RECENT_DAYS)} money={money} date={date} />
            {tracked.length > RECENT_DAYS && (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
                  <CaretRightIcon className="transition-transform group-open:rotate-90" />
                  Earlier · {tracked.length - RECENT_DAYS} days
                </summary>
                <DayList
                  className="mt-2"
                  days={tracked.slice(RECENT_DAYS)}
                  money={money}
                  date={date}
                />
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Figure({
  label,
  value,
  note,
  tone,
  parts,
  money,
  className,
}: {
  label: React.ReactNode
  /** the net position */
  value: string
  note?: string
  tone?: string
  /** what makes it up: cash held and owed */
  parts: Split
  money: (n: number) => string
  className?: string
}) {
  return (
    <div className={cn("grid min-w-0 content-start gap-0.5", className)}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-heading text-xl font-semibold tabular-nums">
        {value}
      </div>
      <div className="truncate text-xs text-muted-foreground tabular-nums">
        Cash {money(parts.cash)} · owed {money(-parts.owed)}
      </div>
      {note && (
        <div className={cn("truncate text-xs tabular-nums", tone)}>{note}</div>
      )}
    </div>
  )
}

function DayList({
  days,
  money,
  date,
  className,
}: {
  days: (GoalDay & { actual: number; prev: number | null })[]
  money: (n: number, signed?: boolean) => string
  date: (iso: string) => string
  className?: string
}) {
  return (
    <ul className={cn("grid text-sm", className)}>
      <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-b pb-1.5 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_6rem_6rem_6rem]">
        <span>Day</span>
        <span className="hidden text-right sm:block">Moved</span>
        <span className="text-right">Net</span>
        <span className="text-right">vs plan</span>
      </li>
      {days.map((d) => {
        const off = d.actual - d.planned
        return (
          <li
            key={d.date}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 border-b py-1.5 tabular-nums last:border-b-0 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_6rem]"
          >
            <span className="truncate">{date(d.date)}</span>
            <span className="hidden text-right text-muted-foreground sm:block">
              {d.prev === null ? "–" : money(d.actual - d.prev, true)}
            </span>
            <span className="text-right">{money(d.actual)}</span>
            <span className={cn("text-right", off >= 0 ? GOOD : BAD)}>
              {money(off, true)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
