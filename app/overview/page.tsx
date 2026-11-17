import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRightIcon,
  TagIcon,
  UploadSimpleIcon,
  UserIcon,
} from "@phosphor-icons/react/ssr"

import { BudgetTrackingCard, OneOffTrackingCard, ThisMonthCard } from "./month-tracking"
import { monthOf, trackBudgets, weekOf } from "./tracking"
import { ViewSwitch } from "./view-switch"
import { LogPanel } from "@/app/log-panel"
import { CashflowChart, CategorySpendChart } from "@/components/charts"
import { MonthPicker } from "@/components/month-picker"
import { PageHeader } from "@/components/page-header"
import { PeriodPicker } from "@/components/period-picker"
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
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
import {
  ACCOUNT_TYPE_LABELS,
  formatDate,
  formatMoney,
  formatMonth,
  fromMonthly,
  parsePeriod,
  PERIOD_LABELS,
  PERIOD_SUFFIX,
} from "@/lib/format"
import { getUserId } from "@/lib/db"
import { planOneOff } from "@/lib/one-offs"
import {
  getAccountHolders,
  getAccountsWithBalances,
  getCategories,
  getCategorySpend,
  getCategorySpendBetween,
  getCategorySpendFor,
  getCategorySpendForBetween,
  getLatestMonth,
  getMonthCashflow,
  getMonthlyCashflow,
  getMyPrefs,
  getOneOffs,
  getPeople,
  getSettings,
  getTransactionMonths,
  getUncategorizedCount,
  getUpcomingExpenses,
} from "@/lib/queries"
import { cn } from "@/lib/utils"
import { parseView } from "@/lib/views"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MAX_CATEGORY_BARS = 10
/** Accounts whose balance is money you hold, not money owed. */
const isCashAccount = (type: string) =>
  !["credit_card", "loan", "credit_line"].includes(type)

export const metadata: Metadata = { title: "Overview" }

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; per?: string; view?: string }>
}) {
  const userId = await getUserId()
  const [params, fmt, months, latest, prefs, people, holders] = await Promise.all([
    searchParams,
    getSettings(),
    getTransactionMonths(),
    getLatestMonth(),
    getMyPrefs(userId),
    getPeople(),
    getAccountHolders(),
  ])
  const { month: monthParam, per } = params
  // you open on your own view or the family's, as you chose in Settings
  const parsed = parseView(params.view)
  const view = parsed === "me" || parsed === "family" ? parsed : prefs.homeView
  const myName = prefs.name ?? people.find((p) => p.id === userId)?.name ?? "Me"
  const mine = [...holders].filter(([, h]) => h === userId).map(([id]) => id)
  const scoped = view === "me" ? mine : null

  // this month and this week, whatever month the rest of the page shows
  const today = todayLocal()
  const thisMonthKey = today.slice(0, 7)
  const week = weekOf(today)
  const monthRange = monthOf(today)
  const month =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam
      : (latest ?? todayLocal().slice(0, 7))
  const period = parsePeriod(per)
  const estimated = period !== "month"
  const perSuffix = estimated ? PERIOD_SUFFIX[period] : ""

  const [
    accounts,
    cashflow,
    spend,
    categories,
    uncategorized,
    upcoming,
    nowCashflow,
    monthSpendNow,
    weekSpendNow,
    { oneOffs },
  ] = await Promise.all([
    getAccountsWithBalances(),
    getMonthlyCashflow(month, 12),
    getCategorySpend(month),
    getCategories(),
    getUncategorizedCount(),
    getUpcomingExpenses(),
    getMonthCashflow(thisMonthKey, scoped ?? undefined),
    scoped ? getCategorySpendFor(thisMonthKey, scoped) : getCategorySpend(thisMonthKey),
    scoped
      ? getCategorySpendForBetween(week.start, week.end, scoped)
      : getCategorySpendBetween(week.start, week.end),
    getOneOffs(),
  ])

  if (accounts.length === 0 || months.length === 0) {
    return <Onboarding hasAccounts={accounts.length > 0} />
  }

  const active = accounts.filter((a) => !a.archived)
  const netWorth = active.reduce((s, a) => s + a.balance, 0)
  const thisMonth = cashflow[cashflow.length - 1]
  const savingsRate =
    thisMonth.income > 0 ? thisMonth.net / thisMonth.income : null
  const activeMonths = cashflow.filter((c) => c.income > 0 || c.expense > 0)
  const avgSpend =
    activeMonths.reduce((s, c) => s + c.expense, 0) /
    Math.max(activeMonths.length, 1)
  const avgIncome =
    activeMonths.reduce((s, c) => s + c.income, 0) /
    Math.max(activeMonths.length, 1)

  const cashNow = active
    .filter((a) => isCashAccount(a.type))
    .reduce((s, a) => s + a.balance, 0)
  const dataEnd = active.reduce<string | null>(
    (m, a) => (a.lastDate && (!m || a.lastDate > m) ? a.lastDate : m),
    null
  )

  const monthOptions = Array.from(new Set([month, ...months]))
    .sort()
    .reverse()
    .map((m) => ({ value: m, label: formatMonth(m, fmt.locale) }))

  const spendPositive = spend
    .filter((s) => s.spent > 0)
    .map((s) => ({ ...s, spent: fromMonthly(s.spent, period) }))
  const topSpend = spendPositive.slice(0, MAX_CATEGORY_BARS)
  const rest = spendPositive.slice(MAX_CATEGORY_BARS)
  if (rest.length) {
    topSpend.push({
      id: null,
      name: `Other (${rest.length})`,
      budget: null,
      spent: rest.reduce((s, r) => s + r.spent, 0),
    })
  }

  const byId = (rows: { id: number | null; spent: number }[]) =>
    new Map(rows.flatMap((r) => (r.id === null ? [] : [[r.id, r.spent] as const])))
  const tracked = trackBudgets(
    categories,
    { month: byId(monthSpendNow), week: byId(weekSpendNow) },
    today
  )
  const mineSet = new Set(mine)
  const oneOffItems = oneOffs
    .filter((o) => !scoped || mineSet.has(o.accountId))
    .map((o) => ({ oneOff: o, plan: planOneOff(o, o.linked, today) }))
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "Unknown account"
  const shown = scoped ? active.filter((a) => mineSet.has(a.id)) : active
  const dayMonth = (d: string) => formatDate(d, fmt.locale).replace(/[,\s]*\d{4}$/, "")
  const monthLabel = formatMonth(thisMonthKey, fmt.locale)
  const scopeLabel = scoped ? "from your accounts" : null

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          view === "me"
            ? `${myName}'s money: the accounts marked as yours.`
            : "The whole household's money."
        }
      >
        <ViewSwitch view={view} me={myName} params={params} />
      </PageHeader>

      {uncategorized > 0 && (
        <Alert>
          <TagIcon />
          <AlertTitle>{uncategorized} transactions need a category</AlertTitle>
          <AlertDescription>
            Uncategorized money out counts as spending until you sort it.
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link href="/transactions?category=none" />}
            >
              Review
            </Button>
          </AlertAction>
        </Alert>
      )}

      {scoped && scoped.length === 0 ? (
        <Alert>
          <UserIcon />
          <AlertTitle>No accounts are marked as yours yet</AlertTitle>
          <AlertDescription>
            Mark whose each account is, and this view shows your own money in and
            out, budgets and one-offs. Joint accounts stay in the family view.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/accounts" />}>
              Mark accounts
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <>
          <ThisMonthCard
            income={nowCashflow.income}
            expense={nowCashflow.expense}
            monthLabel={`${dayMonth(monthRange.start)} – ${dayMonth(today)}`}
            scope={scoped ? "from your accounts" : "the whole household"}
            fmt={fmt}
          />
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <BudgetTrackingCard
              budgets={tracked}
              weekLabel={`Week of ${dayMonth(week.start)}`}
              monthLabel={monthLabel}
              scope={scopeLabel}
              fmt={fmt}
            />
            <OneOffTrackingCard
              items={oneOffItems}
              accountName={accountName}
              scope={scoped ? "Paid from your accounts" : null}
              fmt={fmt}
            />
          </div>
        </>
      )}

      <section className="grid gap-4" aria-labelledby="vitals-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="vitals-heading"
              className="font-heading text-lg font-semibold"
            >
              Household, month by month
            </h2>
            <p className="text-sm text-muted-foreground">
              Everyone&rsquo;s accounts. Transfers between your accounts are
              excluded from income and spending.
              {dataEnd && ` Data up to ${formatDate(dataEnd, fmt.locale)}.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PeriodPicker value={period} />
            <MonthPicker months={monthOptions} value={month} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          <StatCard
            label="Net worth"
            value={formatMoney(netWorth, fmt)}
            hint={`Across ${active.length} active account${active.length === 1 ? "" : "s"}`}
          />
          <StatCard
            label="Cash on hand"
            value={formatMoney(cashNow, fmt)}
            hint="Checking, savings and cash accounts"
          />
          <StatCard
            label={`Income · ${formatMonth(month, fmt.locale, true)}${estimated ? ` · ${PERIOD_LABELS[period].toLowerCase()} est.` : ""}`}
            value={`${formatMoney(fromMonthly(thisMonth.income, period), fmt)}${perSuffix}`}
            hint={`12-month average ${formatMoney(fromMonthly(avgIncome, period), fmt)}${perSuffix}`}
          />
          <StatCard
            label={`Spending · ${formatMonth(month, fmt.locale, true)}`}
            value={formatMoney(thisMonth.expense, fmt)}
            hint={`12-month average ${formatMoney(avgSpend, fmt)}`}
          />
          <StatCard
            label="Saved"
            value={formatMoney(thisMonth.net, fmt, { signed: true })}
            hint={
              savingsRate === null
                ? "No income this month"
                : `${Math.round(savingsRate * 100)}% of income`
            }
          />
        </div>
      </section>

      <LogPanel
        accounts={active.map((a) => ({ id: a.id, name: a.name }))}
        fmt={fmt}
        upcoming={upcoming.map((u) => ({
          id: u.id,
          name: u.name,
          amount: u.amount,
          dueDate: u.dueDate,
          accountId: u.accountId,
          note: u.note,
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle>Income and spending</CardTitle>
          <CardDescription>
            12 months to {formatMonth(month, fmt.locale)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CashflowChart
            fmt={fmt}
            data={cashflow.map((c) => ({
              ...c,
              label: formatMonth(c.month, fmt.locale, true),
            }))}
          />
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Spending by category</CardTitle>
            <CardDescription>
              {formatMonth(month, fmt.locale)}, net of refunds
              {estimated &&
                ` · estimated ${PERIOD_LABELS[period].toLowerCase()}`}
            </CardDescription>
            <CardAction>
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href={`/transactions?month=${month}`} />}
              >
                Transactions
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {topSpend.length > 0 ? (
              <CategorySpendChart data={topSpend} fmt={fmt} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No spending recorded this month.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="grid content-start gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{scoped ? "Your accounts" : "Accounts"}</CardTitle>
              <CardAction>
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/accounts" />}
                >
                  Manage
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-3 text-sm">
                {shown.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-baseline justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{a.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {ACCOUNT_TYPE_LABELS[a.type]}
                      </div>
                    </div>
                    <span className="font-medium tabular-nums">
                      {formatMoney(a.balance, fmt)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint: string
  tone?: "bad"
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={cn(
            "font-heading text-lg font-semibold break-words sm:text-2xl",
            tone === "bad" && "text-destructive"
          )}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="-mt-2 text-xs text-muted-foreground">
        {hint}
      </CardContent>
    </Card>
  )
}

function Onboarding({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <>
      <PageHeader
        title="Welcome"
        description="Let's get your finances in one place."
      />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UploadSimpleIcon />
          </EmptyMedia>
          <EmptyTitle>
            {hasAccounts
              ? "Import your first statement"
              : "Start with your accounts"}
          </EmptyTitle>
          <EmptyDescription>
            {hasAccounts
              ? "Upload a CSV export from your bank. The columns are detected automatically."
              : "Add the accounts you want to track, then import a CSV statement for each. Everything stays on this machine."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            nativeButton={false}
            render={<Link href={hasAccounts ? "/import" : "/accounts"} />}
          >
            {hasAccounts ? "Import a statement" : "Add an account"}
          </Button>
        </EmptyContent>
      </Empty>
    </>
  )
}
