import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRightIcon } from "@phosphor-icons/react/ssr"

import { CashflowChart, CategorySpendChart } from "@/components/charts"
import { MonthPicker } from "@/components/month-picker"
import { PageHeader } from "@/components/page-header"
import { PeriodPicker } from "@/components/period-picker"
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
  ACCOUNT_TYPE_LABELS,
  formatDate,
  formatMoney,
  formatMonth,
  fromMonthly,
  parsePeriod,
  PERIOD_LABELS,
  PERIOD_SUFFIX,
} from "@/lib/format"
import {
  getAccountsWithBalances,
  getCategorySpend,
  getLatestMonth,
  getMonthlyCashflow,
  getSettings,
  getTransactionMonths,
} from "@/lib/queries"
import { cn } from "@/lib/utils"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MAX_CATEGORY_BARS = 10
/** Accounts whose balance is money you hold, not money owed. */
const isCashAccount = (type: string) => !["credit_card", "loan", "credit_line"].includes(type)

export const metadata: Metadata = { title: "Money" }

/** The household month by month: the figures and charts behind Home. */
export default async function MoneySummaryPage({
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
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : (latest ?? todayLocal().slice(0, 7))
  const period = parsePeriod(per)
  const estimated = period !== "month"
  const perSuffix = estimated ? PERIOD_SUFFIX[period] : ""

  const [accounts, cashflow, spend] = await Promise.all([
    getAccountsWithBalances(),
    getMonthlyCashflow(month, 12),
    getCategorySpend(month),
  ])

  const active = accounts.filter((a) => !a.archived)
  const netWorth = active.reduce((s, a) => s + a.balance, 0)
  const cashNow = active.filter((a) => isCashAccount(a.type)).reduce((s, a) => s + a.balance, 0)
  const thisMonth = cashflow[cashflow.length - 1] ?? { month, income: 0, expense: 0, net: 0 }
  const savingsRate = thisMonth.income > 0 ? thisMonth.net / thisMonth.income : null
  const activeMonths = cashflow.filter((c) => c.income > 0 || c.expense > 0)
  const average = (key: "income" | "expense") =>
    activeMonths.reduce((s, c) => s + c[key], 0) / Math.max(activeMonths.length, 1)
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
  const shortMonth = formatMonth(month, fmt.locale, true)

  return (
    <>
      <PageHeader
        title="Money"
        description={
          <>
            The whole household, month by month. Transfers between your accounts are left out.
            {dataEnd && ` Data up to ${formatDate(dataEnd, fmt.locale)}.`}
          </>
        }
      >
        <PeriodPicker value={period} />
        <MonthPicker months={monthOptions} value={month} />
      </PageHeader>

      <section aria-label="This month's figures" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard
          label="Net worth"
          value={formatMoney(netWorth, fmt)}
          hint={`Across ${active.length} account${active.length === 1 ? "" : "s"}`}
        />
        <StatCard label="Cash on hand" value={formatMoney(cashNow, fmt)} hint="Everyday, savings and cash" />
        <StatCard
          label={`Income · ${shortMonth}${estimated ? ` · ${PERIOD_LABELS[period].toLowerCase()} est.` : ""}`}
          value={`${formatMoney(fromMonthly(thisMonth.income, period), fmt)}${perSuffix}`}
          hint={`Average ${formatMoney(fromMonthly(average("income"), period), fmt)}${perSuffix}`}
        />
        <StatCard
          label={`Spending · ${shortMonth}`}
          value={formatMoney(thisMonth.expense, fmt)}
          hint={`Average ${formatMoney(average("expense"), fmt)}`}
        />
        <StatCard
          label="Saved"
          value={formatMoney(thisMonth.net, fmt, { signed: true })}
          hint={savingsRate === null ? "No income this month" : `${Math.round(savingsRate * 100)}% of income`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Income and spending</CardTitle>
          <CardDescription>12 months to {formatMonth(month, fmt.locale)}</CardDescription>
        </CardHeader>
        <CardContent>
          <CashflowChart
            fmt={fmt}
            data={cashflow.map((c) => ({ ...c, label: formatMonth(c.month, fmt.locale, true) }))}
          />
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Spending by category</CardTitle>
            <CardDescription>
              {formatMonth(month, fmt.locale)}, net of refunds
              {estimated && ` · estimated ${PERIOD_LABELS[period].toLowerCase()}`}
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
              <p className="text-sm text-muted-foreground">No spending recorded this month.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/accounts" />}>
                Manage
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">No accounts yet.</p>
            ) : (
              <ul className="grid divide-y divide-border/70 text-sm">
                {active.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{a.name}</div>
                      <div className="text-xs text-muted-foreground">{ACCOUNT_TYPE_LABELS[a.type]}</div>
                    </div>
                    <span className={cn("font-medium tabular-nums", a.balance < 0 && "text-muted-foreground")}>
                      {formatMoney(a.balance, fmt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card size="sm">
      <CardHeader className="gap-1.5">
        <CardDescription className="text-xs font-medium">{label}</CardDescription>
        <CardTitle className="font-heading text-xl! leading-none font-semibold tracking-[-0.01em] break-words tabular-nums sm:text-[1.625rem]!">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  )
}
