import Link from "next/link"
import { addDays, format, parseISO } from "date-fns"
import { CaretRightIcon } from "@phosphor-icons/react/ssr"

import { Meter, type MeterTone } from "@/components/meter"
import { Card, CardContent } from "@/components/ui/card"
import { formatMonth, formatMoney, type MoneyFormat } from "@/lib/format"
import type { MyAllocationView } from "@/lib/month"
import type { AllocationStatus, TrackedAllocation } from "@/lib/my-allocation"
import { cn } from "@/lib/utils"


/** Cards hold to a phone's width with less padding. */
const TIGHT = "max-sm:[--card-spacing:--spacing(5)]"

/** A small label over a group of rows. */
const EYEBROW =
  "text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase"

const TONE: Record<AllocationStatus, MeterTone> = {
  done: "positive",
  on_track: "primary",
  behind: "warning",
  untracked: "primary",
  skipped: "primary",
}

/** Opens a chat with Cas in Claude about this pay's moves. */
const TALK_TO_CAS = `https://claude.ai/new?q=${encodeURIComponent(
  "Ask Cas: let's go over my short-term allocation for this pay. "
)}`

/** The My view's top card: what the plan does with your pay this pay cycle, and how it's going. */
export function MyAllocationCard({
  allocation: a,
  name,
  today,
  fmt,
}: {
  allocation: MyAllocationView
  /** your name */
  name: string
  today: string
  fmt: MoneyFormat
}) {
  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const day = (iso: string) =>
    new Intl.DateTimeFormat(fmt.locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(parseISO(iso))
  const behind = Math.round(a.byNow - a.done)
  const onPace = behind < Math.max(20, a.byNow * 0.02)
  const { spending, cycle } = a
  const over = spending.left < 0
  // the cycle runs to the day before the next pay
  const lastDay = format(addDays(parseISO(cycle.end), -1), "yyyy-MM-dd")
  const short = (iso: string) =>
    new Intl.DateTimeFormat(fmt.locale, {
      day: "numeric",
      month: "short",
    }).format(parseISO(iso))
  const period = cycle.pay ? "this pay" : "the month"

  if (a.moves.length === 0 && a.bills.length === 0) {
    return (
      <Card className={TIGHT}>
        <CardContent className="grid gap-2">
          <h2 className="font-heading text-lg font-semibold">
            {name}&rsquo;s allocation
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">
            The plan doesn&rsquo;t move anything out of your accounts yet.{" "}
            <Link
              href="/plan"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Go over the plan with Cas
            </Link>{" "}
            and each allocation from your pay shows here, with how it&rsquo;s
            going.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={TIGHT}>
      <CardContent className="grid gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="grid gap-0.5">
            <h2 className="font-heading text-lg font-semibold">
              {name}&rsquo;s allocation{" "}
              {cycle.pay
                ? "this pay"
                : `for ${formatMonth(today.slice(0, 7), fmt.locale)}`}
            </h2>
            {cycle.pay && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {cycle.late
                  ? `Since payday, ${short(cycle.start)}`
                  : `${short(cycle.start)} – ${short(lastDay)}`}
              </p>
            )}
          </div>
          {a.pay.next && (
            <p
              className={cn(
                "text-sm tabular-nums",
                cycle.late ? "text-warning" : "text-muted-foreground"
              )}
            >
              {cycle.late ? "Next pay late, due" : "Next pay"}{" "}
              {day(a.pay.next.date)} · {money(a.pay.next.amount)}
            </p>
          )}
        </div>

        {(a.shortTerm.summary || a.shortTerm.stale) && (
          <div className="grid gap-1 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
            {a.shortTerm.summary && (
              <p className="text-pretty">
                <span className="font-semibold">Cas: </span>
                {a.shortTerm.summary}
              </p>
            )}
            {a.shortTerm.stale && (
              <p className="text-xs text-muted-foreground">
                A pay or a move has come in since this was set. Ask Claude to look at it again.
              </p>
            )}
            <a
              href={TALK_TO_CAS}
              target="_blank"
              rel="noopener noreferrer"
              className="w-fit text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Something off? Talk it through with Cas
            </a>
          </div>
        )}

        <div className="grid gap-6 sm:grid-cols-3 sm:gap-8">
          <section className="grid content-start gap-2" aria-label="Your pay">
            <p className={EYEBROW}>Your pay</p>
            <p className="font-heading text-3xl leading-none font-semibold tracking-[-0.015em] tabular-nums">
              {money(a.pay.total)}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {money(a.pay.soFar)} in
              {a.pay.stillDue > 0 && `, ${money(a.pay.stillDue)} still due`}
            </p>
          </section>

          <section className="grid content-start gap-2" aria-label="Allocated">
            <p className={EYEBROW}>Allocated</p>
            <p className="font-heading text-3xl leading-none font-semibold tracking-[-0.015em] tabular-nums">
              {money(a.planned)}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">
                {money(a.done)}
              </span>{" "}
              gone of {money(a.byNow)} due by now
            </p>
            <Meter
              value={a.done}
              max={a.planned}
              mark={a.planned > 0 ? a.byNow / a.planned : undefined}
              tone={onPace ? "positive" : "warning"}
              label={`${money(a.done)} gone of ${money(a.planned)} allocated, ${money(a.byNow)} due by now`}
              className="mt-1 h-2"
            />
            <p
              className={cn(
                "text-xs font-semibold",
                onPace ? "text-positive" : "text-warning"
              )}
            >
              {onPace ? "On track" : `${money(behind)} behind`}
            </p>
          </section>

          <section
            className="grid content-start gap-2"
            aria-label="Left for your spending"
          >
            <p className={EYEBROW}>Your spending</p>
            <p
              className={cn(
                "font-heading text-3xl leading-none font-semibold tracking-[-0.015em] tabular-nums",
                over && "text-destructive"
              )}
            >
              {over ? `−${money(-spending.left)}` : money(spending.left)}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {over ? "over" : "left"} · {money(spending.spent)} spent of{" "}
              {money(spending.allowance)}
            </p>
            <Meter
              value={spending.spent}
              max={spending.allowance}
              mark={
                spending.allowance > 0
                  ? spending.byNow / spending.allowance
                  : undefined
              }
              tone={
                over
                  ? "destructive"
                  : spending.spent > spending.byNow
                    ? "warning"
                    : "primary"
              }
              label={`${money(spending.spent)} spent of ${money(spending.allowance)} left for your spending`}
              className="mt-1 h-2"
            />
          </section>
        </div>

        <div className="grid gap-5 border-t pt-5 lg:grid-cols-2 lg:gap-8">
          {(a.moves.length > 0 || a.otherMoves.parts.length > 0) && (
            <Group
              title="From your pay"
              items={a.moves}
              extras={a.otherMoves.parts}
              paced
              period={period}
              money={money}
            />
          )}
          {a.bills.length > 0 && (
            <Group
              title="Paid from your account"
              items={a.bills}
              period={period}
              money={money}
            />
          )}
        </div>

        <div className="border-t pt-4 text-sm">
          <Link
            href="/plan"
            className="inline-flex min-h-10 w-fit items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            The whole plan <CaretRightIcon aria-hidden />
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}

function Group({
  title,
  items,
  extras = [],
  paced = false,
  period,
  money,
}: {
  title: string
  items: TrackedAllocation[]
  /** moves out of your pay the plan doesn't name, decided as they go */
  extras?: { name: string; amount: number }[]
  /** tick where each should be by now; bills go when they're due, so they don't */
  paced?: boolean
  /** "this pay" or "the month" */
  period: string
  money: (n: number) => string
}) {
  return (
    <section className="grid content-start gap-2">
      <h3
        className={cn(
          EYEBROW,
          "flex items-baseline justify-between border-b pb-2"
        )}
      >
        {title}
        <span className="tabular-nums">
          {money(
            items.reduce((s, i) => s + i.planned, 0) +
              extras.reduce((s, e) => s + e.amount, 0)
          )}
        </span>
      </h3>
      <ul className="grid divide-y divide-border/70">
        {items.map((i) => (
          <li key={i.id} className="grid gap-1.5 py-2.5 first:pt-1">
            <div className="flex items-baseline justify-between gap-3">
              {/* where it goes sits under the title, so a long title can't hide it */}
              <span className="grid min-w-0">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{i.title}</span>
                  {i.extra && (
                    <span className="shrink-0 text-[0.625rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                      This pay
                    </span>
                  )}
                </span>
                {i.to && i.to !== i.title && (
                  <span className="truncate text-xs text-muted-foreground">
                    → {i.to}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sm tabular-nums">
                {i.done !== null && (
                  <span className="font-medium">{money(i.done)} </span>
                )}
                <span className="text-muted-foreground">
                  {i.done !== null ? "of " : ""}
                  {money(i.planned)}
                </span>
              </span>
            </div>
            {i.done !== null && (
              <Meter
                value={i.done}
                max={i.planned}
                mark={paced && i.planned > 0 ? i.byNow / i.planned : undefined}
                tone={TONE[i.status]}
                label={`${i.title}: ${money(i.done)} of ${money(i.planned)}`}
              />
            )}
            <Status item={i} period={period} money={money} />
            {i.note && (
              <p className="text-xs text-pretty text-muted-foreground">
                <span className="font-medium text-foreground/80">Cas:</span>{" "}
                {i.note}
              </p>
            )}
          </li>
        ))}
        {extras.map((e) => (
          <li key={`extra-${e.name}`} className="grid gap-1 py-2.5 first:pt-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-medium">{e.name}</span>
              <span className="shrink-0 text-sm font-medium tabular-nums">
                {money(e.amount)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Moved {period}, outside the plan
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Status({
  item: i,
  period,
  money,
}: {
  item: TrackedAllocation
  period: string
  money: (n: number) => string
}) {
  switch (i.status) {
    case "done":
      return <p className="text-xs text-positive">Done for {period}</p>
    case "behind":
      return (
        <p className="text-xs text-warning tabular-nums">
          {money(i.byNow - i.done!)} short of what should have gone by now
        </p>
      )
    case "on_track":
      return (
        <p className="text-xs text-muted-foreground tabular-nums">
          On track · {money(i.planned - i.done!)} still to go
        </p>
      )
    case "skipped":
      return <p className="text-xs text-muted-foreground">Not this pay</p>
    case "untracked":
      return (
        <p className="text-xs text-muted-foreground">
          Can&rsquo;t see this one: the plan doesn&rsquo;t say which account it
          goes to
        </p>
      )
  }
}
