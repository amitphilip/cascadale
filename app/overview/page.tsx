import { Suspense } from "react"
import type { Metadata } from "next"
import Link from "next/link"
import { addDays, format, parseISO } from "date-fns"
import { CaretRightIcon, UploadSimpleIcon, UserIcon } from "@phosphor-icons/react/ssr"

import { AskCas } from "./ask-cas"
import { DataHealthBanner } from "./data-health-banner"
import { InboxList } from "./inbox-list"
import { ViewSwitch } from "./view-switch"
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

const VERDICT: Record<PlanVerdict, { label: string; className: string }> = {
  realistic: { label: "Realistic", className: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400" },
  stretch: { label: "A stretch", className: "bg-amber-500/15 text-amber-800 dark:text-amber-300" },
  unrealistic: { label: "Not realistic", className: "bg-destructive/10 text-destructive" },
}

/** Cards hold to a phone's width with less padding. */
const TIGHT = "max-sm:[--card-spacing:--spacing(4)]"

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
        <Alert>
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

      <LeftToSpendHero left={left} fmt={fmt} />

      <Card className={TIGHT}>
        <CardHeader>
          <CardTitle>Cas inbox</CardTitle>
          <CardDescription>What needs you, most urgent first.</CardDescription>
        </CardHeader>
        <CardContent>
          <InboxList items={inbox} today={today} locale={fmt.locale} />
        </CardContent>
      </Card>

      <PlanLine verdict={current?.plan.verdict ?? null} note={current?.plan.verdictNote ?? null} />

      <WatchCard budgets={overPace} dueSoon={dueSoon} today={today} fmt={fmt} />

      <AskCas />
    </>
  )
}

/** The one number: what's left to spend this month and stay on plan. */
function LeftToSpendHero({ left, fmt }: { left: LeftToSpend; fmt: MoneyFormat }) {
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

  return (
    <Card className={TIGHT}>
      <CardContent className="grid gap-2">
        <p className="text-sm text-muted-foreground">{over ? "Over plan this month" : "Left to spend this month"}</p>
        <p
          className={cn(
            "font-heading text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl",
            over && "text-destructive"
          )}
        >
          {money(over ? -left.amount : left.amount)}
        </p>
        <p className="text-base font-medium">
          {over
            ? `Hold off on extras until ${nextMonth}.`
            : `About ${money(left.perDay)} a day for ${left.daysLeft} day${left.daysLeft === 1 ? "" : "s"}.`}
        </p>
        <p className="text-sm text-pretty text-muted-foreground">{left.basis}</p>
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
      className="flex min-h-14 items-center gap-3 rounded-xl px-4 py-3 ring-1 ring-foreground/10 hover:bg-muted/40"
    >
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          Plan
          {v && <Badge className={cn("h-5 px-2", v.className)}>{v.label}</Badge>}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground">
          {note ?? "No plan yet. Ask Cas to make one from your income, budgets and bills."}
        </span>
      </span>
      <CaretRightIcon className="shrink-0 text-muted-foreground" aria-hidden />
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
      <p className="px-1 text-sm text-muted-foreground">
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
      <CardContent className="grid gap-5">
        {budgets.length > 0 && (
          <section className="grid gap-1" aria-label="Budgets over pace">
            <h3 className="text-xs font-medium text-muted-foreground">Budgets running fast</h3>
            <ul className="grid divide-y">
              {budgets.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/plan/budgets#budget-${b.id}`}
                    className="flex min-h-12 items-center justify-between gap-3 py-2 hover:bg-muted/40"
                  >
                    <span className="grid min-w-0">
                      <span className="truncate font-medium">{b.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {money(b.spent)} of {money(b.budget)} this {b.period}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-sm font-medium tabular-nums",
                        b.pace === "over" ? "text-destructive" : "text-amber-700 dark:text-amber-400"
                      )}
                    >
                      {b.left < 0 ? `${money(-b.left)} over` : `${money(b.left)} left`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {dueSoon.length > 0 && (
          <section className="grid gap-1" aria-label="One-off payments due soon">
            <h3 className="text-xs font-medium text-muted-foreground">One-off payments due soon</h3>
            <ul className="grid divide-y">
              {dueSoon.map(({ oneOff: o, plan, date, amount }) => {
                const late = plan.status === "overdue" || date < today
                const short = plan.status === "catch_up"
                return (
                  <li key={o.id}>
                    <Link href="/one-offs" className="flex min-h-12 items-center justify-between gap-3 py-2 hover:bg-muted/40">
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
                      <span className="shrink-0 text-sm font-medium tabular-nums">{money(amount)}</span>
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
      <Empty className="border">
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
