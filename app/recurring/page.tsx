import type { Metadata } from "next"
import Link from "next/link"
import { PencilSimpleIcon } from "@phosphor-icons/react/ssr"

import { ApplyAllBudgetsButton, UseAsBudgetButton } from "./budget-actions"
import { BasisPicker } from "@/components/basis-picker"
import { PageHeader } from "@/components/page-header"
import { PeriodPicker } from "@/components/period-picker"
import { ProjectionDialog } from "@/components/recurring-dialog"
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
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  formatDate,
  formatMoney,
  fromMonthly,
  parsePeriod,
  PERIOD_SUFFIX,
  type MoneyFormat,
  type Period,
} from "@/lib/format"
import {
  getAverageWindow,
  getCategories,
  getRecurringInputs,
  getSettings,
} from "@/lib/queries"
import {
  BASIS_DESCRIPTIONS,
  BASIS_LABELS,
  buildBudget,
  CADENCE_LABELS,
  detectRecurring,
  parseBasis,
  growthFactor,
  type BudgetLine,
  type DefaultBasis,
  type ProjectedSeries,
  type RecurringBasis,
  type RecurringOverride,
} from "@/lib/recurring"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Recurring & budget" }

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<{ basis?: string; per?: string }>
}) {
  const [{ basis: basisParam, per }, fmt, window, categories] =
    await Promise.all([
      searchParams,
      getSettings(),
      getAverageWindow(),
      getCategories(),
    ])
  const basis = parseBasis(basisParam)
  const period = parsePeriod(per)
  const { txs, overrides, projections } = await getRecurringInputs(window)

  const overrideByKey = new Map(overrides.map((o) => [o.key, o]))
  const lines = window
    ? buildBudget({
        txs,
        series: detectRecurring(txs, window.last),
        window,
        defaultBasis: basis,
        overrides: overrideByKey,
        categories: new Map(projections.map((p) => [p.categoryId, p])),
      })
    : []
  const catById = new Map(categories.map((c) => [c.id, c]))
  const nameOf = (l: BudgetLine) =>
    l.categoryId === null
      ? `Uncategorized ${l.direction > 0 ? "in" : "out"}`
      : (catById.get(l.categoryId)?.name ?? "Unknown")
  const byProjected = (a: BudgetLine, b: BudgetLine) =>
    b.projected - a.projected || b.actual - a.actual

  const income = lines.filter((l) => l.direction > 0).sort(byProjected)
  const expense = lines.filter((l) => l.direction < 0).sort(byProjected)
  const total = (ls: BudgetLine[]) => ls.reduce((s, l) => s + l.projected, 0)
  const recurring = (ls: BudgetLine[]) =>
    ls.reduce((s, l) => s + l.recurring, 0)
  const totalIncome = total(income)
  const totalExpense = total(expense)
  const net = totalIncome - totalExpense

  const budgets = expense
    .filter(
      (l): l is BudgetLine & { categoryId: number } => l.categoryId !== null
    )
    .map((l) => ({ categoryId: l.categoryId, amount: l.projected }))

  const windowLabel = window
    ? `${formatDate(window.start, fmt.locale)} – ${formatDate(window.last, fmt.locale)}`
    : null
  const p = (monthly: number, signed = false) =>
    formatMoney(fromMonthly(monthly, period), fmt, { signed })
  const ctx = {
    fmt,
    period,
    basis,
    overrides: overrideByKey,
    savedByCategory: new Map(projections.map((p) => [p.categoryId, p])),
  }

  return (
    <>
      <PageHeader
        title="Recurring & budget"
        description={
          <>
            Each category projected forward to plan a budget, with its regular
            income and bills broken out. Default:{" "}
            {BASIS_DESCRIPTIONS[basis].toLowerCase()}.
          </>
        }
      >
        <BasisPicker value={basis} />
        <PeriodPicker value={period} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          title="Projected income"
          value={p(totalIncome)}
          detail={`${p(recurring(income))} from recurring items`}
        />
        <SummaryCard
          title="Projected spending"
          value={p(totalExpense)}
          detail={`${p(recurring(expense))} from recurring items`}
        />
        <SummaryCard
          title="Projected net saved"
          value={p(net, true)}
          valueClassName={net < 0 ? "text-destructive" : undefined}
          detail={
            totalIncome > 0
              ? `${Math.round((net / totalIncome) * 100)}% of income`
              : "No income projected"
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Income</CardTitle>
          <CardDescription>
            By category and source{windowLabel && `, from ${windowLabel}`}.
            Click a basis to change it for a category or a single source.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <BudgetTable lines={income} nameOf={nameOf} kind="income" {...ctx} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expenses</CardTitle>
          <CardDescription>
            Each category is its recurring items plus everything else. Items
            that have stopped are left out.
          </CardDescription>
          <CardAction>
            <ApplyAllBudgetsButton budgets={budgets} />
          </CardAction>
        </CardHeader>
        <CardContent className="px-0">
          <BudgetTable
            lines={expense}
            nameOf={nameOf}
            kind="expense"
            budgetOf={(id) => catById.get(id)?.monthlyBudget ?? null}
            {...ctx}
          />
        </CardContent>
      </Card>
    </>
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
        <CardTitle className={cn("text-2xl tabular-nums", valueClassName)}>
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {detail}
      </CardContent>
    </Card>
  )
}

type Ctx = {
  fmt: MoneyFormat
  period: Period
  basis: DefaultBasis
  overrides: Map<string, RecurringOverride>
  savedByCategory: Map<
    number,
    {
      basis: RecurringBasis | null
      growthRate: number | null
      amount: number | null
    }
  >
}

const formatTrend = (rate: number) => {
  const t = Math.round(rate * 1000) / 10
  return t === 0 ? "—" : `${t > 0 ? "+" : ""}${t}%`
}

function BasisButton({
  basis,
  overridden,
  disabled,
}: {
  basis: RecurringBasis
  overridden: boolean
  disabled?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 gap-1.5 px-2"
      disabled={disabled}
    >
      <Badge variant={overridden ? "secondary" : "outline"}>
        {BASIS_LABELS[basis]}
      </Badge>
      <PencilSimpleIcon className="text-muted-foreground" />
    </Button>
  )
}

function BudgetTable({
  lines,
  nameOf,
  kind,
  budgetOf,
  ...ctx
}: Ctx & {
  lines: BudgetLine[]
  nameOf: (l: BudgetLine) => string
  kind: "income" | "expense"
  budgetOf?: (categoryId: number) => number | null
}) {
  const { fmt, period, basis: pageBasis, savedByCategory } = ctx
  const isExpense = kind === "expense"
  const total = lines.reduce((s, l) => s + l.projected, 0)
  const actual = lines.reduce((s, l) => s + l.actual, 0)
  const last = !isExpense && "pr-(--card-spacing)"

  if (lines.length === 0) {
    return (
      <p className="px-(--card-spacing) text-sm text-muted-foreground">
        No {kind} in the last 12 months.
      </p>
    )
  }

  return (
    <Table className="min-w-[44rem]">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-(--card-spacing)">Item</TableHead>
          <TableHead className="text-right">Latest</TableHead>
          <TableHead className="text-right">Trend /yr</TableHead>
          <TableHead>Basis</TableHead>
          <TableHead className="text-right">
            Avg {PERIOD_SUFFIX[period]}
          </TableHead>
          <TableHead className={cn("text-right", last)}>
            Projected {PERIOD_SUFFIX[period]}
          </TableHead>
          {isExpense && (
            <TableHead className="pr-(--card-spacing) text-right">
              Budget /mo
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => {
          const name = nameOf(l)
          const budget = l.categoryId !== null ? budgetOf?.(l.categoryId) : null
          // what this category's merchants inherit
          const inherited: DefaultBasis =
            l.basis === "custom" ? pageBasis : l.basis
          return [
            <TableRow key={l.key} className="bg-muted/40 font-medium">
              <TableCell className="pl-(--card-spacing)">
                <Link
                  href={`/transactions?category=${l.categoryId ?? "none"}`}
                  className="hover:underline hover:underline-offset-4"
                >
                  {name}
                </Link>
                <div className="text-xs font-normal text-muted-foreground">
                  {formatMoney(fromMonthly(l.recurring, period), fmt)} recurring
                  · {formatMoney(fromMonthly(l.other.monthly, period), fmt)}{" "}
                  other
                </div>
              </TableCell>
              <TableCell className="text-right font-normal text-muted-foreground tabular-nums">
                {formatMoney(fromMonthly(l.previews.latest, period), fmt)}
              </TableCell>
              <TableCell
                className="text-right font-normal text-muted-foreground tabular-nums"
                title={
                  l.growthRate !== null
                    ? `Detected ${formatTrend(l.trend)}`
                    : "Trend in monthly totals"
                }
              >
                {formatTrend(l.growthRate ?? l.trend)}
              </TableCell>
              <TableCell>
                {l.categoryId === null ? (
                  <Badge variant="outline">{BASIS_LABELS[l.basis]}</Badge>
                ) : (
                  <ProjectionDialog
                    target={{
                      kind: "category",
                      categoryId: l.categoryId,
                      name,
                    }}
                    saved={savedByCategory.get(l.categoryId) ?? null}
                    inherited={pageBasis}
                    inheritedFrom="page default"
                    inheritedRate={l.growthRate ?? l.trend}
                    previews={l.previews}
                    fmt={fmt}
                    trigger={
                      <BasisButton basis={l.basis} overridden={l.overridden} />
                    }
                  />
                )}
              </TableCell>
              <TableCell className="text-right font-normal text-muted-foreground tabular-nums">
                {formatMoney(fromMonthly(l.actual, period), fmt)}
              </TableCell>
              <TableCell className={cn("text-right tabular-nums", last)}>
                {formatMoney(fromMonthly(l.projected, period), fmt)}
              </TableCell>
              {isExpense && (
                <TableCell className="pr-(--card-spacing) text-right">
                  <div className="flex items-center justify-end gap-1">
                    <span
                      className={cn(
                        "tabular-nums",
                        budget == null && "text-muted-foreground",
                        budget != null &&
                          budget < l.projected &&
                          "text-destructive"
                      )}
                      title={
                        budget != null && budget < l.projected
                          ? "Budget is below the projection"
                          : undefined
                      }
                    >
                      {budget == null ? "—" : formatMoney(budget, fmt)}
                    </span>
                    {l.categoryId !== null &&
                      Math.round(l.projected) !== budget && (
                        <UseAsBudgetButton
                          budget={{
                            categoryId: l.categoryId,
                            amount: l.projected,
                          }}
                          label={name}
                        />
                      )}
                  </div>
                </TableCell>
              )}
            </TableRow>,
            ...l.series.map((s) => (
              <SeriesRow
                key={s.key}
                s={s}
                isExpense={isExpense}
                category={name}
                inherited={inherited}
                inheritedRate={l.growthRate}
                {...ctx}
              />
            )),
            ...(l.other.average !== 0 || l.other.recent !== 0
              ? [
                  <TableRow key={`${l.key}:other`}>
                    <TableCell className="pl-[calc(var(--card-spacing)+1rem)]">
                      {l.series.length
                        ? "Everything else"
                        : isExpense
                          ? "All spending"
                          : "All income"}
                      <div className="text-xs text-muted-foreground">
                        {l.series.length
                          ? "Not on a regular schedule"
                          : "Nothing on a regular schedule"}
                        {" · latest is a typical recent month"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(fromMonthly(l.other.recent, period), fmt)}
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-xs text-muted-foreground">
                      {BASIS_LABELS[inherited]}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatMoney(fromMonthly(l.other.average, period), fmt)}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", last)}>
                      {formatMoney(fromMonthly(l.other.monthly, period), fmt)}
                    </TableCell>
                    {isExpense && <TableCell className="pr-(--card-spacing)" />}
                  </TableRow>,
                ]
              : []),
          ]
        })}
      </TableBody>
      <TableFooter>
        <TableRow className="font-medium">
          <TableCell className="pl-(--card-spacing)" colSpan={4}>
            Total {kind}
          </TableCell>
          <TableCell className="text-right text-muted-foreground tabular-nums">
            {formatMoney(fromMonthly(actual, period), fmt)}
          </TableCell>
          <TableCell className={cn("text-right tabular-nums", last)}>
            {formatMoney(fromMonthly(total, period), fmt)}
          </TableCell>
          {isExpense && <TableCell />}
        </TableRow>
      </TableFooter>
    </Table>
  )
}

function SeriesRow({
  s,
  isExpense,
  category,
  inherited,
  inheritedRate,
  fmt,
  period,
  overrides,
}: Ctx & {
  s: ProjectedSeries
  isExpense: boolean
  category: string
  inherited: DefaultBasis
  /** the category's growth rate, if you set one */
  inheritedRate: number | null
}) {
  const inactive = s.ended || s.excluded
  const irregular =
    Math.abs(s.averageMonthly - s.latestMonthly) > 0.25 * s.latestMonthly
  const override = overrides.get(s.key)
  const rate = inheritedRate ?? s.trend
  return (
    <TableRow className={cn(inactive && "text-muted-foreground")}>
      <TableCell className="pl-[calc(var(--card-spacing)+1rem)]">
        <div className="flex items-center gap-2">
          <span
            className="max-w-72 truncate"
            title={s.note ? `${s.example} — ${s.note}` : s.example}
          >
            {s.example}
          </span>
          {s.ended && <Badge variant="outline">Stopped</Badge>}
          {s.excluded && <Badge variant="outline">Not recurring</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">
          {CADENCE_LABELS[s.cadence]} · {s.occurrences.length}× · last{" "}
          {formatDate(s.lastDate, fmt.locale)}
          {!s.ended && ` · next ~${formatDate(s.nextDate, fmt.locale)}`}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatMoney(s.latest, fmt)}
      </TableCell>
      <TableCell
        className="text-right text-muted-foreground tabular-nums"
        title={
          s.growthRate !== s.trend
            ? `Detected ${formatTrend(s.trend)}`
            : undefined
        }
      >
        {formatTrend(s.growthRate)}
      </TableCell>
      <TableCell>
        <ProjectionDialog
          target={{
            kind: "series",
            key: s.key,
            name: s.example,
            excluded: s.excluded,
          }}
          saved={override ?? null}
          inherited={inherited}
          inheritedFrom={category}
          inheritedRate={rate}
          previews={{
            latest: s.latestMonthly,
            average: s.averageMonthly,
            growth: s.latestMonthly * growthFactor(rate),
          }}
          fmt={fmt}
          trigger={
            <BasisButton
              basis={s.basis}
              overridden={s.overridden}
              disabled={s.ended}
            />
          }
        />
      </TableCell>
      <TableCell
        className={cn(
          "text-right tabular-nums",
          irregular && !inactive
            ? "font-medium text-foreground"
            : "text-muted-foreground"
        )}
        title={
          irregular && !inactive
            ? "Differs from the latest amount by over 25%: one-offs, annual charges or a price change. Consider the Average basis."
            : undefined
        }
      >
        {formatMoney(fromMonthly(s.averageMonthly, period), fmt)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right tabular-nums",
          !isExpense && "pr-(--card-spacing)"
        )}
      >
        {inactive ? "—" : formatMoney(fromMonthly(s.monthly, period), fmt)}
      </TableCell>
      {isExpense && <TableCell className="pr-(--card-spacing)" />}
    </TableRow>
  )
}
