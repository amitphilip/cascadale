import type { Metadata } from "next"
import { CalendarCheckIcon, PlusIcon } from "@phosphor-icons/react/ssr"

import { LinkTransactionsDialog, OneOffActions, UnlinkButton } from "./one-off-actions"
import { OneOffDialog } from "@/components/one-off-dialog"
import { PageHeader } from "@/components/page-header"
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import {
  FREQUENCY_LABELS,
  FREQUENCY_NOUNS,
  planOneOff,
  type OneOffPlan,
  type OneOffStatus,
  type PlannedMove,
} from "@/lib/one-offs"
import { getAccountsWithBalances, getOneOffs, getSettings } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

export const metadata: Metadata = { title: "One-off payments" }

const STATUS: Record<
  OneOffStatus,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  paid: { label: "Paid", variant: "secondary" },
  on_track: { label: "On track", variant: "outline" },
  catch_up: { label: "Needs money now", variant: "destructive" },
  overdue: { label: "Overdue", variant: "destructive" },
}

/** How many planned moves a card lists before folding the rest away. */
const SHOWN_MOVES = 4

export default async function OneOffsPage() {
  const [{ oneOffs, unlinked }, accounts, fmt] = await Promise.all([
    getOneOffs(),
    getAccountsWithBalances(),
    getSettings(),
  ])
  const today = todayLocal()
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const choosable = accounts
    .filter((a) => !a.archived)
    .map((a) => ({ id: a.id, name: a.name }))
  const items = oneOffs.map((o) => ({ ...o, plan: planOneOff(o, o.linked, today) }))
  const active = items.filter((o) => o.plan.status !== "paid")
  const paid = items.filter((o) => o.plan.status === "paid")
  const money = (n: number, signed = false) => formatMoney(n, fmt, { signed })

  // This calendar month's planned moves across every one-off still running.
  const month = today.slice(0, 7)
  const thisMonth = (kind: PlannedMove["kind"]) =>
    active.reduce(
      (s, o) =>
        s +
        o.plan.moves
          .filter((m) => m.kind === kind && m.date.slice(0, 7) <= month)
          .reduce((t, m) => t + m.amount, 0),
      0
    )

  // Accounts shared by several one-offs: what's held for them against the balance.
  const tracking = [...new Set(active.map((o) => o.accountId))].map((accountId) => {
    const forIt = active.filter((o) => o.accountId === accountId)
    const held = forIt.reduce((s, o) => s + Math.max(0, o.plan.held), 0)
    const balance = accountById.get(accountId)?.balance ?? 0
    return {
      accountId,
      name: accountById.get(accountId)?.name ?? "Unknown account",
      balance,
      held,
      free: Math.round((balance - held) * 100) / 100,
      count: forIt.length,
    }
  })

  const addButton = (
    <Button disabled={choosable.length === 0}>
      <PlusIcon data-icon="inline-start" />
      Add one-off
    </Button>
  )
  const addDialog = <OneOffDialog accounts={choosable} today={today} trigger={addButton} />

  return (
    <>
      <PageHeader
        title="One-off payments"
        description="Known costs paid out by a date, in one go or in parts, with the money gathered in an account first."
      >
        {addDialog}
      </PageHeader>

      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarCheckIcon />
            </EmptyMedia>
            <EmptyTitle>No one-off payments yet</EmptyTitle>
            <EmptyDescription>
              Add a total, the account you&rsquo;ll gather it in and when it&rsquo;s due. The
              page works out what to put in and when, and you link the transactions as they
              happen.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{addDialog}</EmptyContent>
        </Empty>
      ) : (
        <>
          {active.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-3">
              <SummaryCard
                title="Put in this month"
                value={money(thisMonth("in"))}
                detail="Planned contributions to the end of the month"
              />
              <SummaryCard
                title="Pay out this month"
                value={money(thisMonth("out"))}
                detail="Payments due to the end of the month"
              />
              <SummaryCard
                title="Still to pay"
                value={money(active.reduce((s, o) => s + o.plan.remaining, 0))}
                detail={`Across ${active.length} one-off${active.length === 1 ? "" : "s"}`}
              />
            </div>
          )}

          {tracking.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Tracking accounts</CardTitle>
                <CardDescription>
                  What each account holds for its one-offs, and what&rsquo;s left over.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {tracking.map((a) => (
                  <div key={a.accountId} className="grid gap-1 rounded-lg border p-3">
                    <div className="font-medium">{a.name}</div>
                    <Row label="Balance" value={money(a.balance)} />
                    <Row
                      label={`Held for ${a.count} one-off${a.count === 1 ? "" : "s"}`}
                      value={money(a.held)}
                    />
                    <Row
                      label={a.free < 0 ? "Short by" : "Free"}
                      value={money(Math.abs(a.free))}
                      className={a.free < 0 ? "text-destructive" : undefined}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {[...active, ...paid].map((o) => {
              const accountName = accountById.get(o.accountId)?.name ?? "Unknown account"
              return (
                <OneOffCard
                  key={o.id}
                  name={o.name}
                  total={o.total}
                  note={o.note}
                  accountName={accountName}
                  schedule={
                    o.outMode === "spread" && o.outEvery
                      ? `${FREQUENCY_LABELS[o.outEvery]} payments until ${formatDate(o.finishDate, fmt.locale)}`
                      : `Paid in one go on ${formatDate(o.finishDate, fmt.locale)}`
                  }
                  inEvery={FREQUENCY_NOUNS[o.inEvery]}
                  plan={o.plan}
                  linked={o.linked}
                  fmt={fmt}
                  actions={
                    <OneOffActions
                      oneOff={{
                        id: o.id,
                        name: o.name,
                        total: o.total,
                        accountId: o.accountId,
                        startDate: o.startDate,
                        finishDate: o.finishDate,
                        outMode: o.outMode,
                        outEvery: o.outEvery,
                        inEvery: o.inEvery,
                        setAside: o.setAside,
                        note: o.note,
                      }}
                      accounts={choosable}
                      today={today}
                    />
                  }
                  link={
                    <LinkTransactionsDialog
                      oneOff={{ id: o.id, name: o.name, accountName }}
                      candidates={unlinked.filter(
                        (t) => t.accountId === o.accountId && t.date >= o.startDate
                      )}
                      fmt={fmt}
                    />
                  }
                />
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

function OneOffCard({
  name,
  total,
  note,
  accountName,
  schedule,
  inEvery,
  plan,
  linked,
  fmt,
  actions,
  link,
}: {
  name: string
  total: number
  note: string | null
  accountName: string
  schedule: string
  inEvery: string
  plan: OneOffPlan
  linked: { id: number; date: string; description: string; amount: number }[]
  fmt: MoneyFormat
  actions: React.ReactNode
  link: React.ReactNode
}) {
  const money = (n: number, signed = false) => formatMoney(n, fmt, { signed })
  const status = STATUS[plan.status]
  const nextIn = plan.moves.find((m) => m.kind === "in")
  const nextOut = plan.moves.find((m) => m.kind === "out")
  const when = (m: PlannedMove) => (m.now ? "now" : formatDate(m.date, fmt.locale))
  const shown = plan.moves.slice(0, SHOWN_MOVES)
  const folded = plan.moves.slice(SHOWN_MOVES)

  return (
    <Card className={plan.status === "paid" ? "opacity-70" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {name}
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardTitle>
        <CardDescription>
          {accountName} · {schedule}
        </CardDescription>
        <CardAction>{actions}</CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xl font-semibold tabular-nums">
              {money(plan.paidOut + Math.max(0, plan.held))}
            </span>
            <span className="text-muted-foreground tabular-nums">of {money(total)}</span>
          </div>
          <Progress value={Math.round(plan.progress * 100)} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Paid out <span className="text-foreground tabular-nums">{money(plan.paidOut)}</span>
            </span>
            <span>
              Held{" "}
              <span
                className={cn(
                  "tabular-nums",
                  plan.held < 0 ? "text-destructive" : "text-foreground"
                )}
              >
                {money(plan.held)}
              </span>
            </span>
            {plan.surplus > 0 && (
              <span>
                <span className="text-foreground tabular-nums">{money(plan.surplus)}</span> more
                than it needs
              </span>
            )}
          </div>
        </div>

        {plan.status !== "paid" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <NextMove
              label="Next in"
              move={nextIn}
              when={nextIn && when(nextIn)}
              empty="Nothing more to put in"
              money={money}
            />
            <NextMove
              label="Next out"
              move={nextOut}
              when={nextOut && when(nextOut)}
              empty="Nothing left to pay"
              money={money}
            />
          </div>
        )}

        {plan.moves.length > 0 && (
          <div className="grid gap-1">
            <div className="text-xs font-medium text-muted-foreground">
              The plan · {money(plan.toPutIn)} to put in, every {inEvery}
            </div>
            <MoveList moves={shown} when={when} money={money} />
            {folded.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {folded.length} more until {formatDate(folded[folded.length - 1].date, fmt.locale)}
                </summary>
                <MoveList moves={folded} when={when} money={money} />
              </details>
            )}
          </div>
        )}

        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Linked transactions{linked.length > 0 && ` · ${linked.length}`}
            </span>
            {link}
          </div>
          {linked.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              None yet. Link money into {accountName} for it, and payments out.
            </p>
          ) : (
            <ul className="grid">
              {linked.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1 text-sm">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {formatDate(t.date, fmt.locale)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.description}</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      t.amount > 0 && "text-positive"
                    )}
                  >
                    {money(t.amount, true)}
                  </span>
                  <UnlinkButton transactionId={t.id} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  )
}

function NextMove({
  label,
  move,
  when,
  empty,
  money,
}: {
  label: string
  move?: PlannedMove
  when?: string
  empty: string
  money: (n: number) => string
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      {move ? (
        <div className={cn("font-medium tabular-nums", move.now && "text-destructive")}>
          {money(move.amount)} <span className="font-normal text-muted-foreground">{when}</span>
        </div>
      ) : (
        <div className="text-muted-foreground">{empty}</div>
      )}
    </div>
  )
}

function MoveList({
  moves,
  when,
  money,
}: {
  moves: PlannedMove[]
  when: (m: PlannedMove) => string
  money: (n: number, signed?: boolean) => string
}) {
  return (
    <ul className="grid">
      {moves.map((m, i) => (
        <li key={`${m.date}-${m.kind}-${i}`} className="flex items-center gap-2 py-0.5 text-sm">
          <span className="w-20 shrink-0 text-xs text-muted-foreground">{when(m)}</span>
          <span className="flex-1">{m.kind === "in" ? "Put in" : "Pay out"}</span>
          <span
            className={cn(
              "tabular-nums",
              m.kind === "in" && "text-positive"
            )}
          >
            {money(m.kind === "in" ? m.amount : -m.amount, true)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", className)}>{value}</span>
    </div>
  )
}

function SummaryCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}
