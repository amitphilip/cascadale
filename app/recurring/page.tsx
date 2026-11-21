import type { Metadata } from "next"
import Link from "next/link"
import { PencilSimpleIcon } from "@phosphor-icons/react/ssr"

import { ApplyAllBudgetsButton, BudgetEditor, type SavedBudget } from "./budget-actions"
import {
  CategoryGroup,
  CollapsibleGroups,
  ExpandAllButton,
  MOBILE_ROW,
} from "./collapsible-rows"
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
  budgetPeriod,
  percentAmount,
  projectedMonthlyIncome,
  refreshPercentBudgets,
} from "@/lib/budget-percent"
import type { Category } from "@/lib/db/schema"
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

  // percentage budgets are of projected income on the default basis, whichever basis is shown
  const monthlyIncome = !window
    ? null
    : basis === parseBasis(undefined)
      ? totalIncome
      : await projectedMonthlyIncome()
  if (monthlyIncome) await refreshPercentBudgets(categories, monthlyIncome)
  const savedBudget = (c: Category | undefined): SavedBudget => {
    if (!c || c.monthlyBudget === null) return null
    const period = budgetPeriod(c)
    const percent = c.budgetPercent === null ? null : Number(c.budgetPercent)
    const amount =
      percent !== null && monthlyIncome
        ? percentAmount(percent, monthlyIncome, period)
        : Number(period === "week" ? c.weeklyBudget : c.monthlyBudget)
    return { period, amount, percent }
  }

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
    monthlyIncome,
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
            Each category projected forward, with its regular income and bills
            broken out, and its budget as an amount or a share of income. Default:{" "}
            {BASIS_DESCRIPTIONS[basis].toLowerCase()}.
          </>
        }
      >
        <BasisPicker value={basis} />
        <PeriodPicker value={period} />
      </PageHeader>

      <Summary
        items={[
          {
            title: "Projected income",
            value: p(totalIncome),
            detail: `${p(recurring(income))} from recurring items`,
          },
          {
            title: "Projected spending",
            value: p(totalExpense),
            detail: `${p(recurring(expense))} from recurring items`,
          },
          {
            title: "Projected net saved",
            value: p(net, true),
            negative: net < 0,
            detail:
              totalIncome > 0
                ? `${Math.round((net / totalIncome) * 100)}% of income`
                : "No income projected",
          },
        ]}
      />

      <CollapsibleGroups keys={income.map(groupKey)}>
        <Card className={TIGHT}>
          <CardHeader>
            <CardTitle>Income</CardTitle>
            <CardDescription>
              By category and source{windowLabel && `, from ${windowLabel}`}.
              Tap a basis to change it for a category or a single source.
            </CardDescription>
            <CardAction>
              <ExpandAllButton />
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <BudgetTable lines={income} nameOf={nameOf} kind="income" {...ctx} />
          </CardContent>
        </Card>
      </CollapsibleGroups>

      <CollapsibleGroups keys={expense.map(groupKey)}>
        <Card className={TIGHT}>
          <CardHeader>
            <CardTitle>Expenses</CardTitle>
            <CardDescription>
              Each category is its recurring items plus everything else. Items
              that have stopped are left out. Tap a budget to set it as an
              amount or a % of income.
            </CardDescription>
            <CardAction className="flex flex-wrap justify-end gap-1">
              <ExpandAllButton />
              <ApplyAllBudgetsButton budgets={budgets} />
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <BudgetTable
              lines={expense}
              nameOf={nameOf}
              kind="expense"
              budgetOf={(id) => savedBudget(catById.get(id))}
              {...ctx}
            />
          </CardContent>
        </Card>
      </CollapsibleGroups>
    </>
  )
}

type SummaryItem = {
  title: string
  value: string
  detail: string
  negative?: boolean
}

/** The three totals: rows in one card on phones, three cards side by side from sm up. */
function Summary({ items }: { items: SummaryItem[] }) {
  return (
    <>
      <Card size="sm" className="sm:hidden">
        <CardContent>
          <dl className="grid divide-y">
            {items.map((t) => (
              <div
                key={t.title}
                className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <dt className="min-w-0">
                  <span className="block font-medium">{t.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.detail}
                  </span>
                </dt>
                <dd
                  className={cn(
                    "shrink-0 text-lg font-semibold tabular-nums",
                    t.negative && "text-destructive"
                  )}
                >
                  {t.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <div className="grid gap-4 max-sm:hidden sm:grid-cols-3">
        {items.map((t) => (
          <Card key={t.title} size="sm">
            <CardHeader>
              <CardDescription>{t.title}</CardDescription>
              <CardTitle
                className={cn(
                  "text-2xl tabular-nums",
                  t.negative && "text-destructive"
                )}
              >
                {t.value}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {t.detail}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}

/** Cards hold to a phone's width with less padding. */
const TIGHT = "max-sm:[--card-spacing:--spacing(4)]"

// Where each cell sits in a row's phone layout (see MOBILE_ROW); off hides it on phones.
const M = {
  top: "max-sm:col-start-2 max-sm:row-start-1 max-sm:pb-0 max-sm:pr-(--card-spacing)",
  basis: "max-sm:col-start-1 max-sm:row-start-2 max-sm:self-center max-sm:pt-0",
  budget: "max-sm:col-start-2 max-sm:row-start-2 max-sm:self-center max-sm:pt-0",
  off: "max-sm:hidden",
}

/** A category's key for folding its rows: its id, so #budget-<id> links open it. */
const groupKey = (l: BudgetLine) => String(l.categoryId ?? l.key)

type Ctx = {
  fmt: MoneyFormat
  monthlyIncome: number | null
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
  budgetOf?: (categoryId: number) => SavedBudget
}) {
  const { fmt, period, basis: pageBasis, savedByCategory, monthlyIncome } = ctx
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
    <Table className="max-sm:block sm:min-w-[44rem] max-sm:[&>tbody]:block max-sm:[&>tfoot]:block max-sm:[&>thead]:block">
      <TableHeader>
        <TableRow className={cn(MOBILE_ROW, "max-sm:items-center")}>
          <TableHead className="pl-(--card-spacing)">Item</TableHead>
          <TableHead className="text-right max-sm:hidden">Latest</TableHead>
          <TableHead className="text-right max-sm:hidden">Trend /yr</TableHead>
          <TableHead className={M.off}>Basis</TableHead>
          <TableHead className="text-right max-sm:hidden">
            Avg {PERIOD_SUFFIX[period]}
          </TableHead>
          <TableHead
            className={cn("text-right max-sm:pr-(--card-spacing) max-sm:font-normal max-sm:text-muted-foreground", last)}
          >
            Projected {PERIOD_SUFFIX[period]}
          </TableHead>
          {isExpense && (
            <TableHead className={cn("pr-(--card-spacing) text-right", M.off)}>
              Budget
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => {
          const name = nameOf(l)
          const budget = l.categoryId !== null ? (budgetOf?.(l.categoryId) ?? null) : null
          // what this category's merchants inherit
          const inherited: DefaultBasis =
            l.basis === "custom" ? pageBasis : l.basis
          const hasOther = l.other.average !== 0 || l.other.recent !== 0
          return (
            <CategoryGroup
              key={l.key}
              groupKey={groupKey(l)}
              anchor={l.categoryId !== null ? `budget-${l.categoryId}` : undefined}
              detailCount={l.series.length + (hasOther ? 1 : 0)}
              name={
                <>
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
                </>
              }
              cells={
                <>
                  <TableCell className="text-right font-normal text-muted-foreground tabular-nums max-sm:hidden">
                    {formatMoney(fromMonthly(l.previews.latest, period), fmt)}
                  </TableCell>
                  <TableCell
                    className="text-right font-normal text-muted-foreground tabular-nums max-sm:hidden"
                    title={
                      l.growthRate !== null
                        ? `Detected ${formatTrend(l.trend)}`
                        : "Trend in monthly totals"
                    }
                  >
                    {formatTrend(l.growthRate ?? l.trend)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      M.basis,
                      "max-sm:pl-[calc(var(--card-spacing)+2rem)]"
                    )}
                  >
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
                  <TableCell className="text-right font-normal text-muted-foreground tabular-nums max-sm:hidden">
                    {formatMoney(fromMonthly(l.actual, period), fmt)}
                  </TableCell>
                  <TableCell
                    className={cn("text-right tabular-nums", M.top, "max-sm:pt-3", last)}
                  >
                    {formatMoney(fromMonthly(l.projected, period), fmt)}
                  </TableCell>
                  {isExpense && (
                    <TableCell className={cn("pr-(--card-spacing) text-right", M.budget)}>
                      {l.categoryId !== null ? (
                        <BudgetEditor
                          categoryId={l.categoryId}
                          name={name}
                          saved={budget}
                          projected={l.projected}
                          monthlyIncome={monthlyIncome}
                          fmt={fmt}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                </>
              }
            >
              {l.series.map((s) => (
                <SeriesRow
                  key={s.key}
                  s={s}
                  isExpense={isExpense}
                  category={name}
                  inherited={inherited}
                  inheritedRate={l.growthRate}
                  {...ctx}
                />
              ))}
              {hasOther && (
                <TableRow className={MOBILE_ROW}>
                  <TableCell className="pl-[calc(var(--card-spacing)+2.25rem)] max-sm:pb-0 max-sm:whitespace-normal">
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
                  <TableCell className="text-right tabular-nums max-sm:hidden">
                    {formatMoney(fromMonthly(l.other.recent, period), fmt)}
                  </TableCell>
                  <TableCell className="max-sm:hidden" />
                  <TableCell
                    className={cn(
                      "text-xs text-muted-foreground",
                      M.basis,
                      "max-sm:pl-[calc(var(--card-spacing)+2.25rem)] max-sm:pb-2.5"
                    )}
                  >
                    {BASIS_LABELS[inherited]}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums max-sm:hidden">
                    {formatMoney(fromMonthly(l.other.average, period), fmt)}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", M.top, last)}>
                    {formatMoney(fromMonthly(l.other.monthly, period), fmt)}
                  </TableCell>
                  {isExpense && (
                    <TableCell className={cn("pr-(--card-spacing)", M.off)} />
                  )}
                </TableRow>
              )}
            </CategoryGroup>
          )
        })}
      </TableBody>
      <TableFooter>
        <TableRow className={cn("font-medium", MOBILE_ROW)}>
          <TableCell className="pl-(--card-spacing)">Total {kind}</TableCell>
          <TableCell className="max-sm:hidden" colSpan={2} />
          <TableCell className={M.off} />
          <TableCell className="text-right text-muted-foreground tabular-nums max-sm:hidden">
            {formatMoney(fromMonthly(actual, period), fmt)}
          </TableCell>
          <TableCell
            className={cn("text-right tabular-nums max-sm:pr-(--card-spacing)", last)}
          >
            {formatMoney(fromMonthly(total, period), fmt)}
          </TableCell>
          {isExpense && <TableCell className={M.off} />}
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
    <TableRow className={cn(MOBILE_ROW, inactive && "text-muted-foreground")}>
      <TableCell className="pl-[calc(var(--card-spacing)+2.25rem)] max-sm:min-w-0 max-sm:pb-0 max-sm:whitespace-normal">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate sm:max-w-72"
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
      <TableCell className="text-right tabular-nums max-sm:hidden">
        {formatMoney(s.latest, fmt)}
      </TableCell>
      <TableCell
        className="text-right text-muted-foreground tabular-nums max-sm:hidden"
        title={
          s.growthRate !== s.trend
            ? `Detected ${formatTrend(s.trend)}`
            : undefined
        }
      >
        {formatTrend(s.growthRate)}
      </TableCell>
      <TableCell
        className={cn(
          M.basis,
          "max-sm:pl-[calc(var(--card-spacing)+2.25rem)]"
        )}
      >
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
          "text-right tabular-nums max-sm:hidden",
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
          M.top,
          !isExpense && "pr-(--card-spacing)"
        )}
      >
        {inactive ? "—" : formatMoney(fromMonthly(s.monthly, period), fmt)}
      </TableCell>
      {isExpense && (
        <TableCell className={cn("pr-(--card-spacing)", M.off)} />
      )}
    </TableRow>
  )
}
