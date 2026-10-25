import type { Metadata } from "next"
import Link from "next/link"

import { MonthPicker } from "@/components/month-picker"
import { PageHeader } from "@/components/page-header"
import { PeriodPicker } from "@/components/period-picker"
import { ViewToggle } from "@/components/view-toggle"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ACCOUNT_TYPE_LABELS,
  formatDate,
  formatMoney,
  formatMonth,
  fromMonthly,
  parsePeriod,
  perPeriod,
  PERIOD_LABELS,
  PERIOD_SUFFIX,
  type MoneyFormat,
  type Period,
} from "@/lib/format"
import {
  getAverageWindow,
  getBalancesAsOf,
  getIncomeStatement,
  getLatestMonth,
  getSettings,
  getTransactionMonths,
  type BalanceLine,
  type StatementLine,
} from "@/lib/queries"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Statement" }

const LIABILITY_TYPES = new Set(["credit_card", "loan"])

function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export default async function StatementPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; per?: string; view?: string }>
}) {
  const [{ month: monthParam, per, view }, fmt, months, latest, window] = await Promise.all([
    searchParams,
    getSettings(),
    getTransactionMonths(),
    getLatestMonth(),
    getAverageWindow(),
  ])
  const month =
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : (latest ?? currentMonth())
  const period = parsePeriod(per)
  const avgOnly = view === "avg"

  const [statement, balances] = await Promise.all([
    getIncomeStatement(month, window),
    getBalancesAsOf(month, window),
  ])
  const days = window?.days ?? 1
  const windowLabel = window
    ? `${formatDate(window.start, fmt.locale)} – ${formatDate(window.last, fmt.locale)}`
    : null

  const monthOptions = Array.from(new Set([month, ...months]))
    .sort()
    .reverse()
    .map((m) => ({ value: m, label: formatMonth(m, fmt.locale) }))

  const sum = (lines: StatementLine[], key: "month" | "window") =>
    lines.reduce((s, l) => s + l[key], 0)
  const totals = {
    income: { month: sum(statement.income, "month"), window: sum(statement.income, "window") },
    expense: { month: sum(statement.expense, "month"), window: sum(statement.expense, "window") },
  }
  const net = {
    month: totals.income.month - totals.expense.month,
    window: totals.income.window - totals.expense.window,
  }

  const assets = balances.filter((b) => !LIABILITY_TYPES.has(b.type))
  // liabilities are shown as the amount owed
  const liabilities = balances
    .filter((b) => LIABILITY_TYPES.has(b.type))
    .map((b) => ({
      ...b,
      balance: -b.balance,
      average: -b.average,
      windowChange: -b.windowChange,
    }))
  const totalAssets = sumBalances(assets)
  const totalLiabilities = sumBalances(liabilities)
  const netWorth: BalanceValues = {
    balance: totalAssets.balance - totalLiabilities.balance,
    average: totalAssets.average - totalLiabilities.average,
    windowChange: totalAssets.windowChange - totalLiabilities.windowChange,
  }

  // averages-only lists what's active over the window, ranked by average
  const statementLines = (lines: StatementLine[]) =>
    avgOnly ? lines.filter((l) => l.window !== 0).sort((a, b) => b.window - a.window) : lines
  const incomeLines = statementLines(statement.income)
  const expenseLines = statementLines(statement.expense)

  const ctx = { fmt, period, days, month, avgOnly }
  const bctx = { fmt, period, days, avgOnly }
  const statementCols = avgOnly ? 3 : 5
  const balanceCols = avgOnly ? 3 : 4
  const monthLabel = formatMonth(month, fmt.locale)

  return (
    <>
      <PageHeader
        title="Statement"
        description="Income and expenses by category, and what you own and owe. Transfers between your accounts are excluded."
      >
        <ViewToggle avgOnly={avgOnly} />
        <PeriodPicker value={period} />
        {!avgOnly && <MonthPicker months={monthOptions} value={month} />}
      </PageHeader>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Income statement</CardTitle>
            <CardDescription>
              {avgOnly ? (
                <>
                  Average per {PERIOD_NOUNS[period]}
                  {windowLabel && ` over ${windowLabel}`}, net of refunds
                </>
              ) : (
                <>
                  {monthLabel}, net of refunds
                  {period !== "month" && ` · estimated ${PERIOD_LABELS[period].toLowerCase()}`}
                  {windowLabel && ` · average per ${PERIOD_NOUNS[period]} over ${windowLabel}`}
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="grid gap-5 px-(--card-spacing) md:hidden">
              <MobileLines title="Income" lines={incomeLines} total={totals.income} {...ctx} />
              <MobilePair label="Total income" values={totals.income} {...ctx} />
              <MobileLines title="Expenses" lines={expenseLines} total={totals.expense} {...ctx} />
              <MobilePair label="Total expenses" values={totals.expense} {...ctx} />
              <MobilePair label="Net saved" values={net} signed {...ctx} />
            </div>
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-(--card-spacing)">Category</TableHead>
                  {!avgOnly && (
                    <TableHead className="text-right">{formatMonth(month, fmt.locale, true)}</TableHead>
                  )}
                  <TableHead className="text-right">Avg {PERIOD_SUFFIX[period]}</TableHead>
                  {!avgOnly && (
                    <TableHead className="text-right">
                      {formatMonth(month, fmt.locale, true)} share
                    </TableHead>
                  )}
                  <TableHead className="pr-(--card-spacing) text-right">Avg share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SectionRow label="Income" cols={statementCols} />
                {incomeLines.map((l) => (
                  <LineRow key={l.id ?? "none"} line={l} total={totals.income} {...ctx} />
                ))}
                <TotalRow label="Total income" values={totals.income} {...ctx} />

                <SectionRow label="Expenses" cols={statementCols} />
                {expenseLines.map((l) => (
                  <LineRow key={l.id ?? "none"} line={l} total={totals.expense} {...ctx} />
                ))}
                <TotalRow label="Total expenses" values={totals.expense} {...ctx} />
              </TableBody>
              <TableFooter>
                <TotalRow
                  label="Net saved"
                  values={net}
                  signed
                  shares={{
                    month: share(net.month, totals.income.month),
                    window: share(net.window, totals.income.window),
                  }}
                  {...ctx}
                />
              </TableFooter>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Balance sheet</CardTitle>
            <CardDescription>
              {avgOnly ? (
                <>
                  Active accounts, average balance and change per {PERIOD_NOUNS[period]}
                  {windowLabel && ` over ${windowLabel}`}
                </>
              ) : (
                <>
                  Active accounts at the end of {monthLabel}
                  {windowLabel &&
                    ` · average balance and change per ${PERIOD_NOUNS[period]} over ${windowLabel}`}
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="grid gap-5 px-(--card-spacing) md:hidden">
              <MobileBalances title="Assets" lines={assets} {...bctx} />
              <MobileBalanceTotal label="Total assets" values={totalAssets} {...bctx} />
              <MobileBalances title="Liabilities" lines={liabilities} empty="No credit cards or loans" {...bctx} />
              <MobileBalanceTotal label="Total liabilities" values={totalLiabilities} {...bctx} />
              <MobileBalanceTotal label="Net worth" values={netWorth} net {...bctx} />
            </div>
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-(--card-spacing)">Account</TableHead>
                  {!avgOnly && (
                    <TableHead className="text-right">{formatMonth(month, fmt.locale, true)}</TableHead>
                  )}
                  <TableHead className="text-right">Avg balance</TableHead>
                  <TableHead className="pr-(--card-spacing) text-right">
                    Avg change {PERIOD_SUFFIX[period]}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SectionRow label="Assets" cols={balanceCols} />
                {assets.map((a) => (
                  <AccountRow key={a.id} {...a} {...bctx} />
                ))}
                <BalanceTotal label="Total assets" values={totalAssets} {...bctx} />

                <SectionRow label="Liabilities" cols={balanceCols} />
                {liabilities.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={balanceCols} className="pl-(--card-spacing) text-muted-foreground">
                      No credit cards or loans
                    </TableCell>
                  </TableRow>
                ) : (
                  liabilities.map((a) => (
                    <AccountRow key={a.id} {...a} {...bctx} />
                  ))
                )}
                <BalanceTotal label="Total liabilities" values={totalLiabilities} {...bctx} />
              </TableBody>
              <TableFooter>
                <BalanceTotal label="Net worth" values={netWorth} {...bctx} net />
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  )
}

const PERIOD_NOUNS: Record<Period, string> = {
  week: "week",
  fortnight: "fortnight",
  month: "month",
  year: "year",
}

type BalanceValues = Pick<BalanceLine, "balance" | "average" | "windowChange">

function sumBalances(lines: BalanceValues[]): BalanceValues {
  return lines.reduce(
    (s, l) => ({
      balance: s.balance + l.balance,
      average: s.average + l.average,
      windowChange: s.windowChange + l.windowChange,
    }),
    { balance: 0, average: 0, windowChange: 0 }
  )
}

function MobileLines({
  title,
  lines,
  total,
  fmt,
  period,
  days,
  month,
  avgOnly,
}: Ctx & { title: string; lines: StatementLine[]; total: Pair }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">None</p>
      ) : (
        <ul className="grid gap-3">
          {lines.map((line) => (
            <li key={line.id ?? "none"} className="flex items-start justify-between gap-3 text-sm">
              <Link
                href={`/transactions?month=${month}&category=${line.id ?? "none"}`}
                className="min-w-0 underline-offset-4 hover:underline"
              >
                {line.name}
              </Link>
              <div className="shrink-0 text-right tabular-nums">
                <div>
                  {avgOnly || line.month === 0
                    ? avgOnly
                      ? formatMoney(perPeriod(line.window, days, period), fmt)
                      : "—"
                    : formatMoney(fromMonthly(line.month, period), fmt)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {avgOnly
                    ? formatShare(share(line.window, total.window)) || "—"
                    : `avg ${formatMoney(perPeriod(line.window, days, period), fmt)}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MobilePair({
  label,
  values,
  signed,
  fmt,
  period,
  days,
  avgOnly,
}: Ctx & { label: string; values: Pair; signed?: boolean }) {
  const amount = avgOnly
    ? formatMoney(perPeriod(values.window, days, period), fmt, { signed })
    : formatMoney(fromMonthly(values.month, period), fmt, { signed })
  const negative = signed && (avgOnly ? values.window : values.month) < 0
  return (
    <div className="flex items-baseline justify-between gap-3 border-t pt-2 text-sm font-medium">
      <span>{label}</span>
      <span className={cn("tabular-nums", negative && "text-destructive")}>{amount}</span>
    </div>
  )
}

function MobileBalances({
  title,
  lines,
  empty,
  fmt,
  period,
  days,
  avgOnly,
}: BalanceCtx & {
  title: string
  lines: (BalanceValues & { id: number; name: string; type: string })[]
  empty?: string
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty ?? "None"}</p>
      ) : (
        <ul className="grid gap-3">
          {lines.map((line) => (
            <li key={line.name + line.type} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{line.name}</div>
                <div className="text-xs text-muted-foreground">{ACCOUNT_TYPE_LABELS[line.type]}</div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div>{formatMoney(avgOnly ? line.average : line.balance, fmt)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatMoney(perPeriod(line.windowChange, days, period), fmt, { signed: true })}
                  {PERIOD_SUFFIX[period]}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MobileBalanceTotal({
  label,
  values,
  net,
  fmt,
  avgOnly,
}: BalanceCtx & { label: string; values: BalanceValues; net?: boolean }) {
  const amount = formatMoney(avgOnly ? values.average : values.balance, fmt)
  return (
    <div className={cn("flex items-baseline justify-between gap-3 border-t pt-2 text-sm font-medium", net && "text-base")}>
      <span>{label}</span>
      <span className="tabular-nums">{amount}</span>
    </div>
  )
}

type BalanceCtx = { fmt: MoneyFormat; period: Period; days: number; avgOnly: boolean }
type Ctx = BalanceCtx & { month: string }

type Pair = { month: number; window: number }

/** Whole-percent share of a total, or null when there's nothing to share. */
function share(value: number, total: number) {
  return total > 0 && value !== 0 ? Math.round((value / total) * 100) : null
}

function formatShare(value: number | null) {
  return value === null ? "" : `${value}%`
}

function SectionRow({ label, cols = 5 }: { label: string; cols?: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={cols}
        className="pt-4 pl-(--card-spacing) text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {label}
      </TableCell>
    </TableRow>
  )
}

function LineRow({
  line,
  total,
  fmt,
  period,
  days,
  month,
  avgOnly,
}: Ctx & { line: StatementLine; total: Pair }) {
  return (
    <TableRow>
      <TableCell className="pl-(--card-spacing)">
        <Link
          href={`/transactions?month=${month}&category=${line.id ?? "none"}`}
          className="hover:underline hover:underline-offset-4"
        >
          {line.name}
        </Link>
      </TableCell>
      {!avgOnly && (
        <TableCell className="text-right tabular-nums">
          {line.month === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            formatMoney(fromMonthly(line.month, period), fmt)
          )}
        </TableCell>
      )}
      <TableCell className={cn("text-right tabular-nums", !avgOnly && "text-muted-foreground")}>
        {formatMoney(perPeriod(line.window, days, period), fmt)}
      </TableCell>
      {!avgOnly && (
        <TableCell className="text-right text-muted-foreground tabular-nums">
          {formatShare(share(line.month, total.month))}
        </TableCell>
      )}
      <TableCell className="pr-(--card-spacing) text-right text-muted-foreground tabular-nums">
        {formatShare(share(line.window, total.window))}
      </TableCell>
    </TableRow>
  )
}

function TotalRow({
  label,
  values,
  signed,
  shares,
  fmt,
  period,
  days,
  avgOnly,
}: Ctx & {
  label: string
  values: Pair
  signed?: boolean
  /** shown in the share columns, e.g. the savings rate */
  shares?: { month: number | null; window: number | null }
}) {
  return (
    <TableRow className="font-medium">
      <TableCell className="pl-(--card-spacing)">{label}</TableCell>
      {!avgOnly && (
        <TableCell
          className={cn(
            "text-right tabular-nums",
            signed && values.month < 0 && "text-destructive"
          )}
        >
          {formatMoney(fromMonthly(values.month, period), fmt, { signed })}
        </TableCell>
      )}
      <TableCell
        className={cn(
          "text-right tabular-nums",
          avgOnly && signed && values.window < 0 && "text-destructive"
        )}
      >
        {formatMoney(perPeriod(values.window, days, period), fmt, { signed })}
      </TableCell>
      {!avgOnly && (
        <TableCell className="text-right text-muted-foreground tabular-nums">
          {shares && formatShare(shares.month)}
        </TableCell>
      )}
      <TableCell className="pr-(--card-spacing) text-right text-muted-foreground tabular-nums">
        {shares && formatShare(shares.window)}
      </TableCell>
    </TableRow>
  )
}

function AccountRow({
  name,
  type,
  balance,
  average,
  windowChange,
  fmt,
  period,
  days,
  avgOnly,
}: BalanceValues & BalanceCtx & { name: string; type: string }) {
  return (
    <TableRow>
      <TableCell className="pl-(--card-spacing)">
        <div className="font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{ACCOUNT_TYPE_LABELS[type]}</div>
      </TableCell>
      {!avgOnly && (
        <TableCell className="text-right tabular-nums">{formatMoney(balance, fmt)}</TableCell>
      )}
      <TableCell className={cn("text-right tabular-nums", !avgOnly && "text-muted-foreground")}>
        {formatMoney(average, fmt)}
      </TableCell>
      <TableCell className="pr-(--card-spacing) text-right text-muted-foreground tabular-nums">
        {formatMoney(perPeriod(windowChange, days, period), fmt, { signed: true })}
      </TableCell>
    </TableRow>
  )
}

function BalanceTotal({
  label,
  values,
  fmt,
  period,
  days,
  avgOnly,
  net,
}: BalanceCtx & { label: string; values: BalanceValues; net?: boolean }) {
  const change = perPeriod(values.windowChange, days, period)
  return (
    <TableRow className="font-medium">
      <TableCell className="pl-(--card-spacing)">{label}</TableCell>
      {!avgOnly && (
        <TableCell className={cn("text-right tabular-nums", net && "font-semibold")}>
          {formatMoney(values.balance, fmt)}
        </TableCell>
      )}
      <TableCell className={cn("text-right tabular-nums", avgOnly && net && "font-semibold")}>
        {formatMoney(values.average, fmt)}
      </TableCell>
      <TableCell
        className={cn(
          "pr-(--card-spacing) text-right tabular-nums",
          net && change < 0 && "text-destructive"
        )}
      >
        {formatMoney(change, fmt, { signed: true })}
      </TableCell>
    </TableRow>
  )
}
