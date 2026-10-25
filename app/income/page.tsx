import type { Metadata } from "next"
import Link from "next/link"

import { RangePicker } from "./range-picker"
import { parseRange, RANGE_MONTHS } from "./ranges"
import { IncomeChart } from "@/components/charts"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatDate, formatMoney, formatMonth, type MoneyFormat } from "@/lib/format"
import { analyzeIncome, isIncome, type IncomeMonth } from "@/lib/income"
import { getAverageWindow, getCategories, getRecurringInputs, getSettings } from "@/lib/queries"
import { CADENCE_LABELS, detectRecurring } from "@/lib/recurring"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Income" }

const isMonthEnd = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.getUTCDate() === 1
}

const formatPct = (rate: number | null) => {
  if (rate === null) return "—"
  const t = Math.round(rate * 1000) / 10
  return t === 0 ? "0%" : `${t > 0 ? "+" : ""}${t}%`
}

function Pct({ rate, className }: { rate: number | null; className?: string }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        rate === null && "text-muted-foreground",
        rate !== null && rate < -0.0005 && "text-destructive",
        className
      )}
    >
      {formatPct(rate)}
    </span>
  )
}

export default async function IncomePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>
}) {
  const [{ range: rangeParam }, fmt, categories] = await Promise.all([
    searchParams,
    getSettings(),
    getCategories(),
  ])
  const range = parseRange(rangeParam)
  // the run rate depends on pay before the range too, so analyze all of history
  const [history, window] = await Promise.all([
    getAverageWindow(RANGE_MONTHS.all),
    getAverageWindow(RANGE_MONTHS[range]),
  ])
  const { txs, overrides } = await getRecurringInputs(history)

  const income = txs.filter(isIncome)
  const { months: rows, years, sources, oneOffs, trend } =
    history && window
      ? analyzeIncome({
          txs: income,
          series: detectRecurring(income, history.last),
          overrides: new Map(overrides.map((o) => [o.key, o])),
          start: history.start,
          end: history.last,
          from: window.start,
        })
      : { months: [], years: [], sources: [], oneOffs: [], trend: null }

  const catName = new Map(categories.map((c) => [c.id, c.name]))
  const money = (n: number) => formatMoney(n, fmt)
  // headline figures use the last full month, not one the data stops partway through
  const partial = window !== null && !isMonthEnd(window.last) && rows.length > 1
  const full = partial ? rows.slice(0, -1) : rows
  const latest = full.at(-1)
  const yearAgo = full.length > 12 ? full[full.length - 13] : undefined
  const regularTotal = rows.reduce((s, r) => s + r.regular, 0)
  const oneOffTotal = rows.reduce((s, r) => s + r.oneOff, 0)
  const total = regularTotal + oneOffTotal
  const activeSources = sources.filter((s) => s.monthly > 0).length
  const windowLabel = window
    ? `${formatDate(window.start, fmt.locale)} – ${formatDate(window.last, fmt.locale)}`
    : null

  return (
    <>
      <PageHeader
        title="Income"
        description="How your income is changing. Growth is measured on regular pay only: one-offs and bonuses are shown but left out of the percentages."
      >
        <RangePicker value={range} />
      </PageHeader>

      {!latest || total === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No income in this period yet.{" "}
            <Link href="/import" className="underline underline-offset-4">
              Import a statement
            </Link>{" "}
            to get started.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard
              title="Regular income"
              value={`${money(latest.rate)}/mo`}
              detail={`Run rate in ${formatMonth(latest.month, fmt.locale)} from ${activeSources} regular source${activeSources === 1 ? "" : "s"}`}
            />
            <SummaryCard
              title="Change over 12 months"
              value={formatPct(latest.yoy)}
              valueClassName={latest.yoy !== null && latest.yoy < 0 ? "text-destructive" : undefined}
              detail={
                yearAgo && latest.yoy !== null
                  ? `From ${money(yearAgo.rate)}/mo in ${formatMonth(yearAgo.month, fmt.locale)}`
                  : "Needs more than a year of history"
              }
            />
            <SummaryCard
              title="Trend per year"
              value={formatPct(trend)}
              valueClassName={trend !== null && trend < 0 ? "text-destructive" : undefined}
              detail="Typical early months vs recent months, compounded per year"
            />
            <SummaryCard
              title="One-offs"
              value={money(oneOffTotal)}
              detail={`${total > 0 ? Math.round((oneOffTotal / total) * 100) : 0}% of income received · not counted in growth`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Income by month</CardTitle>
              <CardDescription>
                What arrived each month{windowLabel && `, ${windowLabel}`}. The line is regular pay
                averaged over the last 3 months as a monthly rate, so an extra payday or one
                short pay doesn&apos;t look like a change.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <IncomeChart
                data={rows.map((r) => ({
                  label: formatMonth(r.month, fmt.locale, true),
                  regular: r.regular,
                  oneOff: r.oneOff,
                  rate: r.rate,
                }))}
                fmt={fmt}
              />
            </CardContent>
          </Card>

          {years.length > 1 && (
            <Card>
              <CardHeader>
                <CardTitle>By year</CardTitle>
                <CardDescription>
                  Growth compares each year&apos;s average regular rate with the year before.
                  Partial years are averaged over the months you have.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-(--card-spacing)">Year</TableHead>
                      <TableHead className="text-right">Regular</TableHead>
                      <TableHead className="text-right">One-offs</TableHead>
                      <TableHead className="text-right">Avg rate /mo</TableHead>
                      <TableHead className="pr-(--card-spacing) text-right">Growth</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {years.map((y) => (
                      <TableRow key={y.year}>
                        <TableCell className="pl-(--card-spacing) font-medium">
                          {y.year}
                          {y.months < 12 && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {y.months} mo
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(y.regular)}</TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {money(y.oneOff)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(y.rate)}</TableCell>
                        <TableCell className="pr-(--card-spacing) text-right">
                          <Pct rate={y.growth} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Regular sources</CardTitle>
              <CardDescription>
                Income on a regular schedule, with bonuses taken out. Mark a source as not
                recurring on the{" "}
                <Link href="/recurring" className="underline underline-offset-4">
                  Recurring
                </Link>{" "}
                page to count it as one-offs.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {sources.length === 0 ? (
                <p className="px-(--card-spacing) text-sm text-muted-foreground">
                  No income on a regular schedule in this period.
                </p>
              ) : (
                <Table className="min-w-[40rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-(--card-spacing)">Source</TableHead>
                      <TableHead className="text-right">First</TableHead>
                      <TableHead className="text-right">Latest</TableHead>
                      <TableHead className="text-right">Change</TableHead>
                      <TableHead className="pr-(--card-spacing) text-right">Monthly</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sources.map(({ series: s, excluded, first, latest, change, monthly }) => (
                      <TableRow key={s.key} className={cn((excluded || s.ended) && "text-muted-foreground")}>
                        <TableCell className="pl-(--card-spacing)">
                          <div className="flex items-center gap-2">
                            <span className="max-w-72 truncate" title={s.note ? `${s.example} — ${s.note}` : s.example}>
                              {s.example}
                            </span>
                            {s.ended && <Badge variant="outline">Stopped</Badge>}
                            {excluded && <Badge variant="outline">Not recurring</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {s.categoryId !== null ? catName.get(s.categoryId) : "Uncategorized"} ·{" "}
                            {CADENCE_LABELS[s.cadence]} · {formatDate(s.firstDate, fmt.locale)} –{" "}
                            {formatDate(s.lastDate, fmt.locale)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(first)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(latest)}</TableCell>
                        <TableCell className="text-right">
                          <Pct rate={change} />
                        </TableCell>
                        <TableCell className="pr-(--card-spacing) text-right tabular-nums">
                          {monthly > 0 ? money(monthly) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>One-offs</CardTitle>
              <CardDescription>
                Income off a regular schedule, plus bonuses and extra payments from regular sources. Counted in
                what you received, not in growth.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {oneOffs.length === 0 ? (
                <p className="px-(--card-spacing) text-sm text-muted-foreground">
                  No one-offs in this period.
                </p>
              ) : (
                <Table className="min-w-[36rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-(--card-spacing)">Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="pr-(--card-spacing) text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {oneOffs.map((o, i) => (
                      <TableRow key={`${o.date}:${i}`}>
                        <TableCell className="pl-(--card-spacing) whitespace-nowrap text-muted-foreground">
                          {formatDate(o.date, fmt.locale)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="max-w-80 truncate" title={o.description}>
                              {o.description}
                            </span>
                            {o.kind === "bonus" && <Badge variant="secondary">Bonus</Badge>}
                            {o.kind === "extra" && <Badge variant="secondary">Extra pay</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {o.categoryId !== null ? catName.get(o.categoryId) : "Uncategorized"}
                            {o.usual !== null && ` · on top of the usual ${money(o.usual)}`}
                            {o.kind === "extra" && " · between regular paydays"}
                          </div>
                        </TableCell>
                        <TableCell
                          className={cn(
                            "pr-(--card-spacing) text-right tabular-nums",
                            o.amount < 0 && "text-destructive"
                          )}
                        >
                          {money(o.amount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow className="font-medium">
                      <TableCell className="pl-(--card-spacing)" colSpan={2}>
                        Total one-offs
                      </TableCell>
                      <TableCell className="pr-(--card-spacing) text-right tabular-nums">
                        {money(oneOffTotal)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Month by month</CardTitle>
              <CardDescription>
                Change is on the regular rate: from the previous month, and from the same month a
                year earlier.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <MonthTable rows={rows} fmt={fmt} />
            </CardContent>
          </Card>
        </>
      )}
    </>
  )
}

function MonthTable({ rows, fmt }: { rows: IncomeMonth[]; fmt: MoneyFormat }) {
  const money = (n: number) => formatMoney(n, fmt)
  return (
    <Table className="min-w-[40rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-(--card-spacing)">Month</TableHead>
          <TableHead className="text-right">Regular</TableHead>
          <TableHead className="text-right">One-offs</TableHead>
          <TableHead className="text-right">Rate /mo</TableHead>
          <TableHead className="text-right">vs last month</TableHead>
          <TableHead className="pr-(--card-spacing) text-right">vs last year</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.toReversed().map((r) => (
          <TableRow key={r.month}>
            <TableCell className="pl-(--card-spacing)">
              <Link
                href={`/transactions?month=${r.month}`}
                className="hover:underline hover:underline-offset-4"
              >
                {formatMonth(r.month, fmt.locale)}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">{money(r.regular)}</TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">
              {r.oneOff ? money(r.oneOff) : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">{money(r.rate)}</TableCell>
            <TableCell className="text-right">
              <Pct rate={r.mom} />
            </TableCell>
            <TableCell className="pr-(--card-spacing) text-right">
              <Pct rate={r.yoy} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function SummaryCard({
  title,
  value,
  detail,
  valueClassName,
}: {
  title: string
  value: string
  detail: string
  valueClassName?: string
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className={cn("text-2xl tabular-nums", valueClassName)}>{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}
