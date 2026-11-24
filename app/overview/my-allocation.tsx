import Link from "next/link"
import { parseISO } from "date-fns"
import { CaretRightIcon } from "@phosphor-icons/react/ssr"

import { Meter, type MeterTone } from "@/components/meter"
import { Card, CardContent } from "@/components/ui/card"
import { formatMonth, formatMoney, type MoneyFormat } from "@/lib/format"
import type {
  AllocationStatus,
  MyAllocation,
  TrackedAllocation,
} from "@/lib/my-allocation"
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
}

/** The My view's top card: what the plan does with your pay this month, and how it's going. */
export function MyAllocationCard({
  allocation: a,
  name,
  today,
  fmt,
}: {
  allocation: MyAllocation
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
  const { spending } = a
  const over = spending.left < 0

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
              Ask Cas to redo the plan
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
          <h2 className="font-heading text-lg font-semibold">
            {name}&rsquo;s allocation for{" "}
            {formatMonth(today.slice(0, 7), fmt.locale)}
          </h2>
          {a.pay.next && (
            <p className="text-sm text-muted-foreground tabular-nums">
              Next pay {day(a.pay.next.date)} · {money(a.pay.next.amount)}
            </p>
          )}
        </div>

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
          {a.moves.length > 0 && (
            <Group title="From your pay" items={a.moves} paced money={money} />
          )}
          {a.bills.length > 0 && (
            <Group
              title="Paid from your account"
              items={a.bills}
              money={money}
            />
          )}
        </div>

        <div className="grid gap-1 border-t pt-4 text-sm">
          {a.otherMoves.amount >= 1 && (
            <p className="text-pretty">
              <span className="font-semibold tabular-nums">
                {money(a.otherMoves.amount)}
              </span>
              <span className="text-muted-foreground">
                {" "}
                also moved out that the plan doesn&rsquo;t name:{" "}
                {a.otherMoves.parts
                  .slice(0, 3)
                  .map((p) => `${p.name} ${money(p.amount)}`)
                  .join(", ")}
                {a.otherMoves.parts.length > 3 &&
                  `, and ${a.otherMoves.parts.length - 3} more`}
                .
              </span>
            </p>
          )}
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
  paced = false,
  money,
}: {
  title: string
  items: TrackedAllocation[]
  /** tick where each should be by now; bills go when they're due, so they don't */
  paced?: boolean
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
          {money(items.reduce((s, i) => s + i.month, 0))}
        </span>
      </h3>
      <ul className="grid divide-y divide-border/70">
        {items.map((i) => (
          <li key={i.id} className="grid gap-1.5 py-2.5 first:pt-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-medium">
                {i.title}
                {i.to && i.to !== i.title && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
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
                  {money(i.month)}
                </span>
              </span>
            </div>
            {i.done !== null && (
              <Meter
                value={i.done}
                max={i.month}
                mark={paced && i.month > 0 ? i.byNow / i.month : undefined}
                tone={TONE[i.status]}
                label={`${i.title}: ${money(i.done)} of ${money(i.month)}`}
              />
            )}
            <Status item={i} money={money} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Status({
  item: i,
  money,
}: {
  item: TrackedAllocation
  money: (n: number) => string
}) {
  switch (i.status) {
    case "done":
      return <p className="text-xs text-positive">Done for the month</p>
    case "behind":
      return (
        <p className="text-xs text-warning tabular-nums">
          {money(i.byNow - i.done!)} short of what should have gone by now
        </p>
      )
    case "on_track":
      return (
        <p className="text-xs text-muted-foreground tabular-nums">
          On track · {money(i.month - i.done!)} still to go
        </p>
      )
    case "untracked":
      return (
        <p className="text-xs text-muted-foreground">
          Can&rsquo;t see this one: the plan doesn&rsquo;t say which account it
          goes to
        </p>
      )
  }
}
