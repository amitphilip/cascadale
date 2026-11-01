import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CalendarCheckIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  GitDiffIcon,
  PiggyBankIcon,
} from "@phosphor-icons/react/ssr"

import {
  RebuildButton,
  RemoveAdjustmentButton,
  RemovePotButton,
} from "./plan-instructions"
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
import {
  ACTOR_LABELS,
  type Actor,
  type PlanDiff,
} from "@/lib/plan-instructions"
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
  regenerate_plan: "Rebuilt",
}

/** Changes shown in the log before "Show all". */
const RECENT_SHOWN = 6

/** The diff a rebuild stored, if this change was one. */
function rebuildDiff(result: unknown): PlanDiff | null {
  if (!result || typeof result !== "object" || !("diff" in result)) return null
  const diff = (result as { diff: unknown }).diff
  if (
    !diff ||
    typeof diff !== "object" ||
    !("pots" in diff) ||
    !("monthly" in diff)
  )
    return null
  return diff as PlanDiff
}

/**
 * Amendments: what's waiting to go into the plan, the pots and one-off adjustments you've
 * asked for, what the last rebuild changed, what the last check-in suggested changing,
 * and who changed what.
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
  const {
    pots,
    adjustments,
    recentChanges,
    pendingChanges,
    unappliedDecisions,
  } = state
  const lastRebuild = recentChanges
    .filter((c) => c.action === "regenerate_plan" && rebuildDiff(c.result))
    .reduce<(typeof recentChanges)[number] | null>(
      (latest, c) =>
        !latest || Date.parse(c.createdAt) > Date.parse(latest.createdAt)
          ? c
          : latest,
      null
    )
  const diff = lastRebuild ? rebuildDiff(lastRebuild.result) : null
  // dated changes the check-in proposed; past ones are history
  const proposed = checkIn?.result.plan_changes ?? []
  const waiting = state.status === "out_of_date"

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
          Made here, or through Claude and Cas, and kept every time the plan is
          rebuilt.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm">
        {waiting && (
          <section
            className="grid gap-2 rounded-lg border border-foreground/15 bg-muted/40 p-3"
            aria-label="Waiting for a rebuild"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <ClockCounterClockwiseIcon /> Waiting for a rebuild
              </div>
              <RebuildButton planId={state.plan?.id ?? null} />
            </div>
            <ul className="grid gap-1.5">
              {pendingChanges.map((c) => (
                <li key={`c${c.id}`} className="text-pretty">
                  {c.summary ?? c.action}{" "}
                  <span className="text-muted-foreground">
                    · {ACTOR_LABELS[c.actor]}, {date(localDate(c.at))}
                    {c.reason ? ` · ${c.reason}` : ""}
                  </span>
                </li>
              ))}
              {unappliedDecisions.map((d) => (
                <li key={`d${d.id}`} className="text-pretty">
                  <Badge
                    variant="secondary"
                    className="mr-1.5 align-text-bottom"
                  >
                    Decision
                  </Badge>
                  {d.content}{" "}
                  <span className="text-muted-foreground">
                    · Cas, {date(localDate(d.createdAt))}
                  </span>
                </li>
              ))}
              {state.reasons
                .filter((r) => !/not applied/.test(r))
                .map((r) => (
                  <li key={r} className="text-muted-foreground">
                    {r}
                  </li>
                ))}
            </ul>
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
              Ask the planner to put one of these in, or add an adjustment
              through Claude.
            </p>
          </section>
        )}

        {lastRebuild && diff && (
          <RebuildDiff
            change={lastRebuild}
            diff={diff}
            plannerSince={
              !!state.plan &&
              Date.parse(state.plan.createdAt) >
                Date.parse(lastRebuild.createdAt) + 1000
            }
            fmt={fmt}
          />
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

/** What the last rebuild changed: pots, what's left each month, and the data underneath. */
function RebuildDiff({
  change,
  diff,
  plannerSince,
  fmt,
}: {
  change: PlanState["recentChanges"][number]
  diff: PlanDiff
  /** the planner has changed the plan since this rebuild, so this isn't the whole story */
  plannerSince: boolean
  fmt: MoneyFormat
}) {
  const money = (n: number) => formatMoney(n, fmt)
  const before = diff.monthly.before
  const after = diff.monthly.after
  const counts = [
    diff.bills.added.length && `${diff.bills.added.length} bills found`,
    diff.bills.removed.length && `${diff.bills.removed.length} bills gone`,
    diff.incomes.added.length && `${diff.incomes.added.length} incomes found`,
    diff.incomes.removed.length &&
      `${diff.incomes.removed.length} incomes gone`,
    diff.adjustments.added.length &&
      `${diff.adjustments.added.length} adjustments added`,
    diff.adjustments.removed.length &&
      `${diff.adjustments.removed.length} adjustments removed`,
  ].filter((x): x is string => typeof x === "string")
  const potLines = [
    ...diff.pots.added.map((p) => ({
      key: `+${p.pot}`,
      text: `${p.pot} added`,
      amount: `${money(p.monthly)}/mo`,
      tone: "good" as const,
    })),
    ...diff.pots.removed.map((p) => ({
      key: `-${p.pot}`,
      text: `${p.pot} removed`,
      amount: `was ${money(p.monthly)}/mo`,
      tone: "bad" as const,
    })),
    ...diff.pots.changed.map((p) => ({
      key: `~${p.pot}`,
      text: p.pot,
      amount: `${money(p.monthlyBefore)} → ${money(p.monthlyAfter)}/mo`,
      tone: "none" as const,
    })),
  ]

  const heading = (
    <>
      <ArrowsClockwiseIcon /> Last rebuild ·{" "}
      {formatDate(localDate(change.createdAt), fmt.locale)} by{" "}
      {ACTOR_LABELS[change.actor]}
    </>
  )
  const detail = (
    <>
      <div className="grid gap-1 sm:grid-cols-3 sm:gap-2">
        <Delta
          label="Left each month"
          before={before ? money(before.free) : null}
          after={money(after.free)}
          bad={after.free < 0}
        />
        <Delta
          label="Accounts below zero"
          before={before ? String(diff.overdrafts.before) : null}
          after={String(diff.overdrafts.after)}
          bad={diff.overdrafts.after > diff.overdrafts.before}
        />
        <Delta
          label="Bills not in a pot"
          before={before ? String(diff.uncoveredBills.before) : null}
          after={String(diff.uncoveredBills.after)}
          bad={diff.uncoveredBills.after > diff.uncoveredBills.before}
        />
      </div>
      {potLines.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {potLines.map((l) => (
            <li
              key={l.key}
              className="flex items-baseline justify-between gap-3"
            >
              <span
                className={cn(
                  "truncate",
                  l.tone === "good" && "text-positive",
                  l.tone === "bad" && "text-muted-foreground line-through"
                )}
              >
                {l.text}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {l.amount}
              </span>
            </li>
          ))}
        </ul>
      )}
      {counts.length > 0 && (
        <p className="text-xs text-pretty text-muted-foreground">
          Data underneath: {counts.join(", ")}.
        </p>
      )}
    </>
  )

  // its numbers describe a plan that's since been replaced, so they stay out of the way
  if (plannerSince)
    return (
      <details className="group" aria-label="Last rebuild">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <CaretRightIcon className="transition-transform group-open:rotate-90" />
          {heading} · since replaced by the planner
        </summary>
        <div className="mt-2 grid gap-2">{detail}</div>
      </details>
    )

  return (
    <section className="grid gap-2" aria-label="Last rebuild">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {heading}
        {change.reason ? ` · ${change.reason}` : ""}
      </div>
      {detail}
    </section>
  )
}

function Delta({
  label,
  before,
  after,
  bad,
}: {
  label: string
  before: string | null
  after: string
  bad: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:grid sm:justify-normal sm:gap-0.5 sm:rounded-lg sm:border sm:p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
        {before !== null && (
          <>
            <span className="text-sm text-muted-foreground">{before}</span>
            <ArrowRightIcon className="size-3 self-center text-muted-foreground" />
          </>
        )}
        <span
          className={cn(
            "font-heading font-semibold",
            bad && "text-destructive"
          )}
        >
          {after}
        </span>
      </div>
    </div>
  )
}
