import { Suspense } from "react"
import type { Metadata } from "next"
import Link from "next/link"
import { addDays, format, parseISO } from "date-fns"
import { CaretRightIcon, CheckCircleIcon, UploadSimpleIcon, UserIcon } from "@phosphor-icons/react/ssr"

import { AskCas } from "./ask-cas"
import { BudgetTracking } from "./budget-tracking"
import { DataHealthBanner } from "./data-health-banner"
import { InboxList } from "./inbox-list"
import { ViewSwitch } from "./view-switch"
import { Meter } from "@/components/meter"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getPendingCorrections } from "@/lib/cas-queue"
import { getUserId } from "@/lib/db"
import type { OneOff, PlanVerdict } from "@/lib/db/schema"
import { formatDate, formatMonth, formatMoney, type MoneyFormat } from "@/lib/format"
import { getInbox } from "@/lib/inbox"
import { loadMonthFigures } from "@/lib/month"
import type { MonthFigures } from "@/lib/month-figures"
import { planOneOff, type OneOffPlan } from "@/lib/one-offs"
import { getCurrentPlan } from "@/lib/plan-data"
import {
  getAccountHolders,
  getAccountsWithBalances,
  getCategories,
  getMyPrefs,
  getOneOffs,
  getPeople,
  getSettings,
  getTransactionMonths,
} from "@/lib/queries"
import { cn } from "@/lib/utils"
import { parseView } from "@/lib/views"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

export const metadata: Metadata = { title: "Home" }

/** One-off payments due within this many days show on Home. */
const DUE_SOON_DAYS = 30

const VERDICT: Record<PlanVerdict, { label: string; variant: "positive" | "warning" | "destructive" }> = {
  realistic: { label: "Realistic", variant: "positive" },
  stretch: { label: "A stretch", variant: "warning" },
  unrealistic: { label: "Not realistic", variant: "destructive" },
}

/** Cards hold to a phone's width with less padding. */
const TIGHT = "max-sm:[--card-spacing:--spacing(5)]"

/** A small label over a group of rows. */
const EYEBROW = "text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase"

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const userId = await getUserId()
  const [params, fmt, prefs, people, holders, accounts, months] = await Promise.all([
    searchParams,
    getSettings(),
    getMyPrefs(userId),
    getPeople(),
    getAccountHolders(),
    getAccountsWithBalances(),
    getTransactionMonths(),
  ])

  if (accounts.length === 0 || months.length === 0) {
    return <Onboarding hasAccounts={accounts.length > 0} />
  }

  // you open on your own view or the family's, as you chose in Settings
  const parsed = parseView(params.view)
  const view = parsed === "me" || parsed === "family" ? parsed : prefs.homeView
  const myName = prefs.name ?? people.find((p) => p.id === userId)?.name ?? "Me"
  const mine = [...holders].filter(([, h]) => h === userId).map(([id]) => id)
  const scoped = view === "me" ? mine : null

  const today = todayLocal()
  const [figures, inbox, current, categories, { oneOffs }, waiting] = await Promise.all([
    loadMonthFigures({ mine: scoped }),
    getInbox(),
    getCurrentPlan(),
    getCategories(),
    getOneOffs(),
    getPendingCorrections(),
  ])

  const soon = format(addDays(parseISO(today), DUE_SOON_DAYS), "yyyy-MM-dd")
  const mineSet = new Set(mine)
  const dueSoon = oneOffs
    .filter((o) => !scoped || mineSet.has(o.accountId))
    .map((o) => {
      const plan = planOneOff(o, o.linked, today)
      const nextOut = plan.moves.find((m) => m.kind === "out")
      return { oneOff: o, plan, date: nextOut?.date ?? o.finishDate, amount: nextOut?.amount ?? plan.remaining }
    })
    .filter((d) => d.plan.status !== "paid" && (d.plan.status === "overdue" || d.date <= soon))
    .sort((a, b) => a.date.localeCompare(b.date))

  return (
    <>
      <PageHeader
        title="Home"
        description={view === "me" ? `${myName}'s money: the accounts marked as yours.` : "The whole household's money."}
      >
        <ViewSwitch view={view} me={myName} params={params} />
      </PageHeader>

      <Suspense fallback={null}>
        <DataHealthBanner />
      </Suspense>

      {scoped && scoped.length === 0 && (
        <Alert variant="warning">
          <UserIcon />
          <AlertTitle>No accounts are marked as yours yet</AlertTitle>
          <AlertDescription>Mark whose each account is, and this view shows your own money.</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/accounts" />}>
              Mark accounts
            </Button>
          </AlertAction>
        </Alert>
      )}

      <MonthCard figures={figures} today={today} yours={view === "me" ? myName : null} fmt={fmt} />

      {/* On a wide screen budget tracking and the inbox lead on the left; the plan and what's worth
          a look sit alongside. On a phone it's one column in that order. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6">
          <Card className={TIGHT}>
            <CardHeader>
              <CardTitle id="budget-tracking">Budget tracking</CardTitle>
              <CardDescription>Tap a category to see where it went, and move anything in the wrong place.</CardDescription>
            </CardHeader>
            <CardContent>
              <BudgetTracking
                figures={figures}
                categories={categories}
                oneOffs={oneOffs.map((o) => ({ id: o.id, name: o.name, accountId: o.accountId }))}
                accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
                waiting={waiting.length}
                fmt={fmt}
              />
            </CardContent>
          </Card>

          <Card className={TIGHT}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Cas inbox
                {inbox.length > 0 && (
                  <span className="rounded-full bg-primary px-2 text-xs leading-5 font-semibold text-primary-foreground tabular-nums">
                    {inbox.length}
                  </span>
                )}
              </CardTitle>
              <CardDescription>What needs you, most urgent first.</CardDescription>
            </CardHeader>
            <CardContent>
              <InboxList items={inbox} today={today} locale={fmt.locale} />
            </CardContent>
          </Card>
        </div>

        <div className="grid min-w-0 gap-6">
          <PlanLine verdict={current?.plan.verdict ?? null} note={current?.plan.verdictNote ?? null} />
          <WatchCard dueSoon={dueSoon} today={today} fmt={fmt} />
          <AskCas />
        </div>
      </div>
    </>
  )
}

/** This month at a glance: money in against what's expected, money out against the plan, and where it's heading. */
function MonthCard({
  figures,
  today,
  yours,
  fmt,
}: {
  figures: MonthFigures
  today: string
  /** your name in the My view, for the line on your own accounts */
  yours: string | null
  fmt: MoneyFormat
}) {
  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const { in: income, out, net, month } = figures
  const still = income.stillDue.filter((p) => p.status !== "missed")
  const missed = income.stillDue.filter((p) => p.status === "missed")
  const over = out.diff > 0
  // a few dollars either way is on plan
  const onPlan = Math.abs(out.diff) < Math.max(20, out.planned * 0.01)
  const day = (iso: string) =>
    new Intl.DateTimeFormat(fmt.locale, { weekday: "short", day: "numeric", month: "short" }).format(parseISO(iso))

  return (
    <Card className={TIGHT}>
      <CardContent className="grid gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="font-heading text-lg font-semibold">{formatMonth(today.slice(0, 7), fmt.locale)} so far</h2>
          <p className="text-sm text-muted-foreground tabular-nums">
            {month.daysLeft} day{month.daysLeft === 1 ? "" : "s"} to go
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 sm:gap-8">
          <section className="grid content-start gap-2" aria-label="Money in">
            <p className={EYEBROW}>In</p>
            <p className="font-heading text-3xl leading-none font-semibold tracking-[-0.015em] tabular-nums sm:text-4xl">
              {money(income.soFar)}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              of <span className="font-medium text-foreground">{money(income.expected)}</span> expected
            </p>
            <Meter
              value={income.soFar}
              max={income.expected}
              tone="positive"
              label={`${money(income.soFar)} in of ${money(income.expected)} expected`}
              className="mt-1 h-2"
            />
            {still.length > 0 && (
              <ul className="mt-1 grid gap-1 text-xs text-muted-foreground">
                {still.map((p) => (
                  <li key={`${p.name}:${p.date}`} className="flex justify-between gap-3">
                    <span className={cn("truncate", p.status === "late" && "text-warning")}>
                      {p.name} · {p.status === "late" ? `late, due ${day(p.date)}` : day(p.date)}
                    </span>
                    <span className="shrink-0 tabular-nums">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {missed.length > 0 && (
              <p className="text-xs text-destructive">
                Not counted: {missed.map((p) => `${p.name} (due ${day(p.date)})`).join(", ")} hasn&rsquo;t landed.
              </p>
            )}
          </section>

          <section className="grid content-start gap-2" aria-label="Money out">
            <p className={EYEBROW}>Out</p>
            <p className="font-heading text-3xl leading-none font-semibold tracking-[-0.015em] tabular-nums sm:text-4xl">
              {money(out.soFar)}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              of <span className="font-medium text-foreground">{money(out.planned)}</span> expected
            </p>
            <Meter
              value={out.soFar}
              max={out.planned}
              mark={month.share}
              tone={out.soFar > out.planned ? "destructive" : "primary"}
              label={`${money(out.soFar)} out of ${money(out.planned)} expected`}
              className="mt-1 h-2"
            />
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
              <span className="text-muted-foreground">Heading for</span>
              <span className="font-semibold">{money(out.projected)}</span>
              <span
                className={cn(
                  "rounded-full px-2 text-xs leading-5 font-semibold",
                  onPlan
                    ? "bg-muted text-muted-foreground"
                    : over
                      ? "bg-destructive/10 text-destructive"
                      : "bg-positive/10 text-positive"
                )}
              >
                {onPlan ? "on plan" : `${over ? "+" : "−"}${money(Math.abs(out.diff))} ${over ? "over" : "under"}`}
              </span>
            </p>
          </section>
        </div>

        <div className="grid gap-1 border-t pt-4 text-sm">
          <p className="text-pretty">
            By the end of the month:{" "}
            <span className={cn("font-semibold tabular-nums", net < 0 ? "text-destructive" : "text-positive")}>
              {net < 0 ? `${money(-net)} short` : `${money(net)} to spare`}
            </span>
            <span className="text-muted-foreground"> · expected in, less where spending is heading.</span>
          </p>
          {yours && figures.yours && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Budgets are the household&rsquo;s, so this is everyone. {yours}&rsquo;s accounts so far:{" "}
              {money(figures.yours.in)} in, {money(figures.yours.out)} out.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Cas's verdict on the plan in a line, through to the Plan. */
function PlanLine({ verdict, note }: { verdict: PlanVerdict | null; note: string | null }) {
  const v = verdict ? VERDICT[verdict] : null
  return (
    <Link
      href="/plan"
      className="group flex min-h-14 items-center gap-3 rounded-2xl bg-card px-5 py-4 shadow-card transition-colors hover:bg-accent/60 max-sm:px-4"
    >
      <span className="grid min-w-0 flex-1 gap-1.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          Your plan
          {v && <Badge variant={v.variant}>{v.label}</Badge>}
        </span>
        <span className="line-clamp-3 text-sm text-pretty text-muted-foreground">
          {note ?? "No plan yet. Ask Cas to make one from your income, budgets and bills."}
        </span>
      </span>
      <CaretRightIcon className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  )
}

type DueSoon = { oneOff: OneOff; plan: OneOffPlan; date: string; amount: number }

/** One-off payments coming up in the next month. */
function WatchCard({ dueSoon, today, fmt }: { dueSoon: DueSoon[]; today: string; fmt: MoneyFormat }) {
  if (dueSoon.length === 0) {
    return (
      <p className="flex items-start gap-2 rounded-2xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
        <CheckCircleIcon weight="fill" className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
        No one-off payments are due in the next month.
      </p>
    )
  }
  const money = (n: number) => formatMoney(n, fmt)
  return (
    <Card className={TIGHT}>
      <CardHeader>
        <CardTitle>One-off payments due soon</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="-mx-2 grid">
          {dueSoon.map(({ oneOff: o, plan, date, amount }) => {
            const late = plan.status === "overdue" || date < today
            const short = plan.status === "catch_up"
            return (
              <li key={o.id}>
                <Link href="/one-offs" className="flex min-h-12 items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/60">
                  <span className="grid min-w-0">
                    <span className="truncate font-medium">{o.name}</span>
                    <span className={cn("text-xs", late || short ? "text-destructive" : "text-muted-foreground")}>
                      {late
                        ? `Overdue since ${formatDate(date, fmt.locale)}`
                        : short
                          ? `Due ${formatDate(date, fmt.locale)} · needs money put in now`
                          : `Due ${formatDate(date, fmt.locale)} · ${money(plan.held)} put aside`}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{money(amount)}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

function Onboarding({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <>
      <PageHeader title="Welcome" description="Let's get your finances in one place." />
      <Empty className="rounded-2xl border border-dashed bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UploadSimpleIcon />
          </EmptyMedia>
          <EmptyTitle>{hasAccounts ? "Import your first statement" : "Start with your accounts"}</EmptyTitle>
          <EmptyDescription>
            {hasAccounts
              ? "Upload a CSV export from your bank, or link a bank feed. The columns are detected automatically."
              : "Add the accounts you want to track, then import a statement or link a bank feed for each."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button nativeButton={false} render={<Link href={hasAccounts ? "/import" : "/accounts"} />}>
            {hasAccounts ? "Import a statement" : "Add an account"}
          </Button>
        </EmptyContent>
      </Empty>
    </>
  )
}
