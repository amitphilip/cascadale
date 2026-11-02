import {
  CalendarCheckIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  GitDiffIcon,
  PiggyBankIcon,
} from "@phosphor-icons/react/ssr"

import { RemoveAdjustmentButton, RemovePotButton } from "./plan-instructions"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { CheckIn } from "@/lib/db/schema"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import type { PlanSnapshot } from "@/lib/plan"
import { ACTOR_LABELS, type Actor } from "@/lib/plan-instructions"
import type { getPlanState } from "@/lib/plan-service"
import { cn } from "@/lib/utils"
import { localDate } from "@/supabase/functions/_shared/akahu"

type PlanState = Awaited<ReturnType<typeof getPlanState>>

const FREQUENCY_TEXT = {
  payday: "every payday",
  fortnightly: "a fortnight",
  monthly: "a month",
} as const

const ACTION_LABELS: Record<string, string> = {
  upsert_pot: "Pot",
  remove_pot: "Pot removed",
  add_plan_adjustment: "Adjustment",
  remove_plan_adjustment: "Adjustment removed",
}

/** Changes shown in the log before "Show all". */
const RECENT_SHOWN = 6

/**
 * Amendments: decisions still to carry out, the pots and one-off adjustments you've asked
 * for, what the last check-in suggested changing, and who changed what.
 */
export function PlanChangesCard({
  state,
  snap,
  checkIn,
  today,
  fmt,
}: {
  state: PlanState
  snap: PlanSnapshot
  checkIn: CheckIn | null
  today: string
  fmt: MoneyFormat
}) {
  const { pots, adjustments, recentChanges, unappliedDecisions } = state
  // dated changes the check-in proposed; past ones are history
  const proposed = checkIn?.result.plan_changes ?? []
  const waiting = unappliedDecisions.length > 0

  if (
    !waiting &&
    !pots.length &&
    !adjustments.length &&
    !recentChanges.length &&
    !proposed.length
  )
    return null

  const money = (n: number) => formatMoney(n, fmt)
  const date = (iso: string) => formatDate(iso, fmt.locale)
  const accountName = (id: number) =>
    snap.accounts.find((a) => a.id === id)?.name ?? "Unknown account"
  const by = (actor: Actor, reason: string | null) =>
    `${ACTOR_LABELS[actor]}${reason ? ` · ${reason}` : ""}`

  return (
    <Card id="changes">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitDiffIcon /> Changes to the plan
        </CardTitle>
        <CardDescription className="text-pretty">
          Made here, or through Claude and Cas. Each one is in the plan as soon
          as it’s made.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm">
        {waiting && (
          <section
            className="grid gap-2 rounded-lg border border-foreground/15 bg-muted/40 p-3"
            aria-label="Decided, not in the plan yet"
          >
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <ClockCounterClockwiseIcon /> Decided, not in the plan yet
            </div>
            <ul className="grid gap-1.5">
              {unappliedDecisions.map((d) => (
                <li key={d.id} className="text-pretty">
                  {d.content}{" "}
                  <span className="text-muted-foreground">
                    · Cas, {date(localDate(d.createdAt))}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-pretty text-muted-foreground">
              Ask Cas to put these in.
            </p>
          </section>
        )}

        {pots.length > 0 && (
          <section className="grid gap-2" aria-label="Your pots">
            <div className="text-xs font-medium text-muted-foreground">
              Your pots
            </div>
            <ul className="grid gap-2">
              {pots.map((p) => (
                <li key={p.id} className="flex min-w-0 items-center gap-3">
                  <PiggyBankIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {p.name} · {money(p.amount)} {FREQUENCY_TEXT[p.frequency]}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[
                        p.incomeName && `from ${p.incomeName}`,
                        p.fromAccountId &&
                          `out of ${accountName(p.fromAccountId)}`,
                        p.toAccountId && `into ${accountName(p.toAccountId)}`,
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
          </section>
        )}

        {adjustments.length > 0 && (
          <section className="grid gap-2" aria-label="One-off adjustments">
            <div className="text-xs font-medium text-muted-foreground">
              One-off adjustments
            </div>
            <ul className="grid gap-2">
              {adjustments.map((a) => {
                const label =
                  a.kind === "skip"
                    ? `Skip ${a.name}`
                    : a.kind === "add"
                      ? `${a.name}: ${money(a.amount ?? 0)}`
                      : `${a.name} to ${money(a.amount ?? 0)}`
                return (
                  <li key={a.id} className="flex min-w-0 items-center gap-3">
                    <Badge
                      variant="secondary"
                      className="shrink-0 tabular-nums"
                    >
                      {date(a.date)}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {by(a.createdBy, a.reason)}
                      </div>
                    </div>
                    <RemoveAdjustmentButton id={a.id} label={label} />
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {proposed.length > 0 && checkIn && (
          <section
            className="grid gap-2"
            aria-label="Suggested by the last check-in"
          >
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CalendarCheckIcon /> Suggested by the check-in of{" "}
              {date(localDate(checkIn.createdAt))}
            </div>
            <ul className="grid gap-2">
              {proposed.map((c, i) => {
                const past = c.date < today
                return (
                  <li
                    key={i}
                    className={cn(
                      "flex min-w-0 items-start gap-3",
                      past && "text-muted-foreground"
                    )}
                  >
                    <Badge
                      variant={past ? "outline" : "secondary"}
                      className="shrink-0 tabular-nums"
                    >
                      {date(c.date)}
                    </Badge>
                    <div className="min-w-0 flex-1 text-pretty">
                      {c.change}
                      {c.amount !== null && (
                        <span className="tabular-nums">
                          {" "}
                          · {money(c.amount)}
                        </span>
                      )}
                      {past && <span className="text-xs"> · past</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="text-xs text-pretty text-muted-foreground">
              Ask Cas to put one of these in.
            </p>
          </section>
        )}

        {recentChanges.length > 0 && (
          <details className="group grid gap-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              History · {recentChanges.length}{" "}
              {recentChanges.length === 1 ? "change" : "changes"}
            </summary>
            <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
              {recentChanges.slice(0, RECENT_SHOWN).map((c) => (
                <li key={c.id} className="truncate">
                  {date(localDate(c.createdAt))} · {ACTOR_LABELS[c.actor]} ·{" "}
                  {c.summary ?? ACTION_LABELS[c.action] ?? c.action}
                  {c.reason ? ` · ${c.reason}` : ""}
                </li>
              ))}
              {recentChanges.length > RECENT_SHOWN && (
                <li>and {recentChanges.length - RECENT_SHOWN} more</li>
              )}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
