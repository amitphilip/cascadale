import { Suspense } from "react"
import type { Metadata } from "next"
import Link from "next/link"
import { addDays, format, parseISO } from "date-fns"
import { CaretRightIcon, CheckCircleIcon, UploadSimpleIcon, UserIcon } from "@phosphor-icons/react/ssr"

import { AskCas } from "./ask-cas"
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
import { trackBudgets, weekOf, type BudgetTrack } from "@/lib/budget-tracking"
import { getUserId } from "@/lib/db"
import type { OneOff, PlanVerdict } from "@/lib/db/schema"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import { getInbox } from "@/lib/inbox"
import { getLeftToSpend, type LeftToSpend } from "@/lib/left-to-spend"
import { planOneOff, type OneOffPlan } from "@/lib/one-offs"
import { getCurrentPlan } from "@/lib/plan-data"
import {
  getAccountHolders,
  getAccountsWithBalances,
  getCategories,
  getCategorySpend,
  getCategorySpendBetween,
  getCategorySpendFor,
  getCategorySpendForBetween,
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
  const week = weekOf(today)
  const month = today.slice(0, 7)
  const [left, inbox, current, categories, monthSpend, weekSpend, { oneOffs }] = await Promise.all([
    getLeftToSpend(view),
    getInbox(),
    getCurrentPlan(),
    getCategories(),
    scoped ? getCategorySpendFor(month, scoped) : getCategorySpend(month),
    scoped
      ? getCategorySpendForBetween(week.start, week.end, scoped)
      : getCategorySpendBetween(week.start, week.end),
    getOneOffs(),
  ])

  const byId = (rows: { id: number | null; spent: number }[]) =>
    new Map(rows.flatMap((r) => (r.id === null ? [] : [[r.id, r.spent] as const])))
  const overPace = trackBudgets(categories, { month: byId(monthSpend), week: byId(weekSpend) }, today).filter(
    (b) => b.pace !== "on_pace"
  )

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

      {/* On a wide screen the number and the inbox lead on the left; the plan and what's worth
          a look sit alongside. On a phone it's one column in that order. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6">
          <LeftToSpendHero left={left} today={today} fmt={fmt} />

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
          <WatchCard budgets={overPace} dueSoon={dueSoon} today={today} fmt={fmt} />
          <AskCas />
        </div>
      </div>
    </>
  )
}

/** The one number: what's left to spend this month and stay on plan. */
function LeftToSpendHero({ left, today, fmt }: { left: LeftToSpend; today: string; fmt: MoneyFormat }) {
  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const over = left.amount < 0
  const nextMonth = formatDate(format(addDays(parseISO(left.periodEnd), 1), "yyyy-MM-dd"), fmt.locale)

  if (left.budgeted <= 0) {
    return (
      <Card className={TIGHT}>
        <CardHeader>
          <CardDescription>Left to spend this month</CardDescription>
          <CardTitle className="text-base">Set budgets to see what&rsquo;s left to spend.</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" nativeButton={false} render={<Link href="/plan/budgets" />}>
            Set budgets
          </Button>
        </CardContent>
      </Card>
    )
  }

  const used = left.spent + left.unbudgeted
  const daysInMonth = Number(left.periodEnd.slice(8, 10))
  const gone = Math.min(1, Number(today.slice(8, 10)) / daysInMonth)
  const ahead = !over && used / left.budgeted > gone + 0.1

  return (
    <Card className={cn(TIGHT, "relative")}>
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-1", over ? "bg-destructive" : ahead ? "bg-warning" : "bg-positive")}
      />
      <CardContent className="grid gap-5">
        <div className="grid gap-1">
          <p className="text-sm font-medium text-muted-foreground">
            {over ? "Over plan this month" : "Left to spend this month"}
          </p>
          <p
            className={cn(
              "font-heading text-5xl leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-6xl",
              over && "text-destructive"
            )}
          >
            {over && <span className="mr-1 text-[0.6em] align-[0.2em]">&minus;</span>}
            {money(over ? -left.amount : left.amount)}
          </p>
          <p className="mt-2 text-base font-medium text-pretty">
            {over
              ? `Hold off on extras until ${nextMonth}.`
              : `About ${money(left.perDay)} a day for ${left.daysLeft} day${left.daysLeft === 1 ? "" : "s"}.`}
          </p>
        </div>

        <div className="grid gap-2">
          <Meter
            value={used}
            max={left.budgeted}
            mark={gone}
            tone={over ? "destructive" : ahead ? "warning" : "positive"}
            label={`${money(used)} spent of ${money(left.budgeted)} flexible budget`}
            className="h-2"
          />
          <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
            <span>
              <span className="font-medium text-foreground">{money(used)}</span> spent
            </span>
            <span>of {money(left.budgeted)} flexible budget</span>
          </div>
        </div>

        <p className="border-t pt-4 text-xs text-pretty text-muted-foreground">{left.basis}</p>
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
        <span className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-semibold">
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

/** Only what's worth a look: budgets running over pace, and one-off payments coming up. */
function WatchCard({
  budgets,
  dueSoon,
  today,
  fmt,
}: {
  budgets: BudgetTrack[]
  dueSoon: DueSoon[]
  today: string
  fmt: MoneyFormat
}) {
  if (budgets.length === 0 && dueSoon.length === 0) {
    return (
      <p className="flex items-start gap-2 rounded-2xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
        <CheckCircleIcon weight="fill" className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
        Every budget is on pace, and no one-off payments are due in the next month.
      </p>
    )
  }
  const money = (n: number) => formatMoney(n, fmt)
  return (
    <Card className={TIGHT}>
      <CardHeader>
        <CardTitle>Worth a look</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        {budgets.length > 0 && (
          <section className="grid gap-1" aria-label="Budgets over pace">
            <h3 className={EYEBROW}>Budgets running fast</h3>
            <ul className="-mx-2 grid">
              {budgets.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/plan/budgets#budget-${b.id}`}
                    className="grid gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/60"
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-medium">{b.name}</span>
                      <span
                        className={cn(
                          "shrink-0 text-sm font-semibold tabular-nums",
                          b.pace === "over" ? "text-destructive" : "text-warning"
                        )}
                      >
                        {b.left < 0 ? `${money(-b.left)} over` : `${money(b.left)} left`}
                      </span>
                    </span>
                    <Meter
                      value={b.spent}
                      max={b.budget}
                      mark={b.budget > 0 ? b.expected / b.budget : undefined}
                      tone={b.pace === "over" ? "destructive" : "warning"}
                      label={`${money(b.spent)} of ${money(b.budget)}`}
                    />
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {money(b.spent)} of {money(b.budget)} this {b.period}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {dueSoon.length > 0 && (
          <section className="grid gap-1" aria-label="One-off payments due soon">
            <h3 className={EYEBROW}>One-off payments due soon</h3>
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
          </section>
        )}
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
