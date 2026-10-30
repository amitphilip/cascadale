import Link from "next/link"
import {
  ArrowRightIcon,
  TagIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react/ssr"

import { LogPanel } from "./log-panel"
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
import { Progress } from "@/components/ui/progress"
import {
  ACCOUNT_TYPE_LABELS,
  formatDate,
  formatMoney,
  formatMonth,
  fromMonthly,
  parsePeriod,
  PERIOD_LABELS,
  PERIOD_SUFFIX,
  type MoneyFormat,
} from "@/lib/format"
import { combinedLow, isCashAccount, simulate } from "@/lib/plan"
import { loadSnapshot } from "@/lib/planner"
import {
  getAccountsWithBalances,
  getCategories,
  getCategorySpend,
  getCheckIns,
  getLatestMonth,
  getMonthlyCashflow,
  getSettings,
  getTransactionMonths,
  getUncategorizedCount,
  getUpcomingExpenses,
} from "@/lib/queries"
import { cn } from "@/lib/utils"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MAX_CATEGORY_BARS = 10
/** How far ahead the vitals look for bills and the lowest cash balance. */
const AHEAD_DAYS = 30

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; per?: string }>
}) {
  const [{ month: monthParam, per }, fmt, months, latest] = await Promise.all([
    searchParams,
    getSettings(),
    getTransactionMonths(),
    getLatestMonth(),
  ])
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
    snapshot,
    upcoming,
    checkIns,
  ] = await Promise.all([
    getAccountsWithBalances(),
    getMonthlyCashflow(month, 12),
    getCategorySpend(month),
    getCategories(),
    getUncategorizedCount(),
    loadSnapshot(),
    getUpcomingExpenses(),
    getCheckIns(),
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

  // Next 30 days with no plan: recurring bills, your one-offs, and day-to-day spending.
  const sim = snapshot && simulate(snapshot, null, AHEAD_DAYS)
  const due = sim?.events.filter((e) => e.kind === "bill") ?? []
  const dueTotal = due.reduce((s, e) => s + e.amount, 0)
  const oneOffs = due.filter((e) => e.oneOff).length
  const low = sim && combinedLow(snapshot, sim)
  const accountName = (id: number) =>
    accounts.find((a) => a.id === id)?.name ?? "Unknown account"

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

  const spentByCategory = new Map(spend.map((s) => [s.id, s.spent]))
  const budgets = categories
    .filter(
      (c) => c.kind === "expense" && c.monthlyBudget && c.monthlyBudget > 0
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      budget: c.monthlyBudget!,
      spent: Math.max(spentByCategory.get(c.id) ?? 0, 0),
    }))
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget)

  return (
    <>
      <PageHeader
        title="Overview"
        description="Transfers between your accounts are excluded from income and spending."
      >
        <PeriodPicker value={period} />
        <MonthPicker months={monthOptions} value={month} />
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

      <section className="grid gap-4" aria-labelledby="vitals-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2
            id="vitals-heading"
            className="font-heading text-lg font-semibold"
          >
            Vitals
          </h2>
          {dataEnd && (
            <p className="text-sm text-muted-foreground">
              Data up to {formatDate(dataEnd, fmt.locale)}
            </p>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Net worth"
            value={formatMoney(netWorth, fmt)}
            hint={`Across ${active.length} active account${active.length === 1 ? "" : "s"}`}
          />
          <StatCard
            label="Cash on hand"
            value={formatMoney(cashNow, fmt)}
            hint={
              low
                ? `All accounts combined dip to ${formatMoney(low.balance, fmt)} on ${formatDate(low.date, fmt.locale)}`
                : "Checking, savings and cash accounts"
            }
            tone={low && low.balance < 0 ? "bad" : undefined}
          />
          <StatCard
            label={`Due in ${AHEAD_DAYS} days`}
            value={formatMoney(dueTotal, fmt)}
            hint={
              due.length
                ? `${due.length} payment${due.length === 1 ? "" : "s"}${oneOffs ? `, incl. ${oneOffs} one-off${oneOffs === 1 ? "" : "s"}` : ""}`
                : "No bills detected"
            }
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
        bills={due
          .filter((e) => !e.oneOff)
          .map((e) => ({
            date: e.date,
            name: e.name,
            amount: e.amount,
            account: accountName(e.accountId),
          }))}
        checkIns={checkIns}
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
              <CardTitle>Budgets</CardTitle>
              <CardDescription>
                {formatMonth(month, fmt.locale)}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {budgets.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Set monthly budgets on{" "}
                  <Link
                    href="/categories"
                    className="underline underline-offset-4"
                  >
                    expense categories
                  </Link>{" "}
                  to track them here.
                </p>
              ) : (
                budgets.map((b) => <BudgetRow key={b.id} {...b} fmt={fmt} />)
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Accounts</CardTitle>
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
                {active.map((a) => (
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
            "font-heading text-xl font-semibold break-words sm:text-2xl",
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

function BudgetRow({
  name,
  budget,
  spent,
  fmt,
}: {
  name: string
  budget: number
  spent: number
  fmt: MoneyFormat
}) {
  const ratio = spent / budget
  const over = ratio > 1
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-sm">
        <span className="font-medium">{name}</span>
        <span
          className={cn(
            "tabular-nums",
            over ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {formatMoney(spent, fmt)} of {formatMoney(budget, fmt)}
          {over && " · over"}
        </span>
      </div>
      <Progress
        value={Math.min(ratio, 1) * 100}
        aria-label={`${name}: ${Math.round(ratio * 100)}% of budget`}
        className={cn(
          over && "[&_[data-slot=progress-indicator]]:bg-destructive"
        )}
      />
    </div>
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
