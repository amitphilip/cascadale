import { merchantKey } from "@/lib/rules"

/**
 * Recurring-item detection and budget projection. Pure functions: the query layer feeds in
 * transactions, this groups them into series per category and merchant (by the rule that
 * categorized them), works out each series' cadence, and projects every category a month
 * forward on the basis you choose: per category, with optional per-merchant exceptions.
 */

export const RECURRING_BASES = [
  "latest",
  "average",
  "growth",
  "custom",
] as const
export type RecurringBasis = (typeof RECURRING_BASES)[number]
/** Bases that can be the page-wide default; custom needs an amount, so it is set per row. */
export type DefaultBasis = Exclude<RecurringBasis, "custom">

export function parseBasis(value: string | undefined): DefaultBasis {
  return value === "average" || value === "growth" ? value : "latest"
}

export const BASIS_LABELS: Record<RecurringBasis, string> = {
  latest: "Latest",
  average: "Average",
  growth: "Growth",
  custom: "Custom",
}

export const BASIS_DESCRIPTIONS: Record<RecurringBasis, string> = {
  latest:
    "Recurring items at their most recent amount, plus a typical recent month of everything else",
  average:
    "What it actually came to per month, including one-offs like bonuses or annual fees",
  growth:
    "The latest figure grown at its yearly trend, averaged over the next 12 months",
  custom: "A monthly amount you set",
}

export const CADENCES = [
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "yearly",
] as const
export type Cadence = (typeof CADENCES)[number]

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
}

const DAYS_PER_MONTH = 365.25 / 12

/** Nominal length and the range of gaps (days) accepted for each cadence. */
export const CADENCE_DAYS: Record<
  Cadence,
  { days: number; min: number; max: number }
> = {
  weekly: { days: 7, min: 5, max: 9 },
  fortnightly: { days: 14, min: 12, max: 16 },
  monthly: { days: DAYS_PER_MONTH, min: 26, max: 35 },
  quarterly: { days: 365.25 / 4, min: 84, max: 98 },
  yearly: { days: 365.25, min: 350, max: 380 },
}

/** Share of gaps that must fall within the cadence's range to count as recurring. */
const REGULARITY = 0.6
/** Yearly trend is clamped to this range so a single step change can't run away. */
const MAX_GROWTH = 1
const MIN_GROWTH = -0.5

export type RecurringTx = {
  date: string
  accountId: number
  description: string
  amount: number
  categoryId: number | null
  categoryKind: "income" | "expense" | null
  /** the rule that categorized it: transactions under one rule are one merchant */
  ruleId: number | null
  /** your note on that rule, e.g. what the merchant actually is */
  ruleNote: string | null
}

/** Your choices for one merchant series. */
export type RecurringOverride = {
  key: string
  basis: RecurringBasis | null
  /** yearly growth as a fraction, e.g. 0.03 */
  growthRate: number | null
  /** monthly amount for the custom basis */
  amount: number | null
  excluded: boolean
}

/** Your choices for a whole category. */
export type CategoryProjection = {
  categoryId: number
  basis: RecurringBasis | null
  /** yearly growth applied to every item in the category without its own rate */
  growthRate: number | null
  /** monthly amount for the custom basis */
  amount: number | null
}

export type Occurrence = { date: string; amount: number }

export type RecurringSeries = {
  key: string
  categoryId: number | null
  /** the account most of its payments go through */
  accountId: number
  /** a real description, for display */
  example: string
  note: string | null
  /** +1 money in, −1 money out */
  direction: 1 | -1
  cadence: Cadence
  /** per-date totals, oldest first, as positive amounts */
  occurrences: Occurrence[]
  firstDate: string
  lastDate: string
  /** expected date of the next occurrence */
  nextDate: string
  /** no occurrence for well over one cadence before the data ends */
  ended: boolean
  latest: number
  /** latest amount as a monthly figure */
  latestMonthly: number
  /** actual amount per month since the series started, one-offs included */
  averageMonthly: number
  /** detected yearly trend, as a fraction */
  trend: number
  /** total over the window, as a positive amount */
  total: number
}

export type ProjectedSeries = RecurringSeries & {
  basis: RecurringBasis
  /** set on the merchant itself rather than inherited from its category */
  overridden: boolean
  growthRate: number
  excluded: boolean
  /** projected monthly amount; 0 when excluded or ended */
  monthly: number
}

const DAY = 86_400_000
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const daysBetween = (a: string, b: string) =>
  Math.round((toTime(b) - toTime(a)) / DAY)
const addDays = (iso: string, days: number) =>
  new Date(toTime(iso) + Math.round(days) * DAY).toISOString().slice(0, 10)

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const round2 = (n: number) => Math.round(n * 100) / 100
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

/** The direction a category's regular payments go: income in, expenses out. */
function directionOf(tx: RecurringTx): 1 | -1 {
  if (tx.categoryKind === "income") return 1
  if (tx.categoryKind === "expense") return -1
  return tx.amount > 0 ? 1 : -1
}

const lineKey = (categoryId: number | null, direction: number) =>
  `${categoryId ?? "none"}:${direction > 0 ? "in" : "out"}`

/** The series a transaction would belong to, or null for refunds and reversals. */
export function seriesKeyOf(tx: RecurringTx) {
  const direction = directionOf(tx)
  if (Math.sign(tx.amount) !== direction) return null
  const merchant = tx.ruleId
    ? `r${tx.ruleId}`
    : `m:${merchantKey(tx.description)}`
  return `${lineKey(tx.categoryId, direction)}:${merchant}`
}

function detectCadence(dates: string[]): Cadence | null {
  if (dates.length < 3) return null
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d))
  const typical = median(gaps)
  for (const cadence of CADENCES) {
    const { min, max } = CADENCE_DAYS[cadence]
    if (typical < min || typical > max) continue
    const regular = gaps.filter((g) => g >= min && g <= max).length
    return regular / gaps.length >= REGULARITY ? cadence : null
  }
  return null
}

/**
 * Yearly trend from the typical early amount to the typical recent amount. Medians keep
 * one-off bonuses or annual charges from skewing it. Spans under a year count as a full
 * year, on the assumption that prices and pay change about once a year.
 */
function detectTrend(occ: Occurrence[]) {
  if (occ.length < 2) return 0
  const k = Math.max(1, Math.min(3, Math.floor(occ.length / 3)))
  const early = median(occ.slice(0, k).map((o) => o.amount))
  const late = median(occ.slice(-k).map((o) => o.amount))
  if (early <= 0 || late <= 0) return 0
  const years = Math.max(
    1,
    daysBetween(occ[k - 1].date, occ[occ.length - k].date) / 365.25
  )
  const rate = (late / early) ** (1 / years) - 1
  return Math.min(MAX_GROWTH, Math.max(MIN_GROWTH, rate))
}

/**
 * Yearly trend of monthly totals: the median of the slopes between every pair of months
 * (Theil–Sen), relative to the median month. A single unusually big month barely moves it.
 */
function robustTrend(monthly: number[]) {
  const n = monthly.length
  const level = median(monthly)
  if (n < 3 || level <= 0) return 0
  const slopes: number[] = []
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      slopes.push((monthly[j] - monthly[i]) / (j - i))
  // change across the observed months; spans under a year count as a year, as in detectTrend
  const rate = (median(slopes) * Math.min(12, n - 1)) / level
  return Math.min(MAX_GROWTH, Math.max(MIN_GROWTH, rate))
}

/** Average over the next 12 months of an amount compounding monthly at a yearly rate. */
export function growthFactor(rate: number) {
  let total = 0
  for (let m = 1; m <= 12; m++) total += (1 + rate) ** (m / 12)
  return total / 12
}

/**
 * Group transactions by category, direction and merchant, and keep the groups that
 * repeat on a regular cadence. `dataEnd` is the last date with data, used to tell
 * whether a series has stopped.
 */
export function detectRecurring(
  txs: RecurringTx[],
  dataEnd: string
): RecurringSeries[] {
  const groups = new Map<string, RecurringTx[]>()
  for (const tx of txs) {
    const key = seriesKeyOf(tx)
    if (key) groups.set(key, [...(groups.get(key) ?? []), tx])
  }

  const out: RecurringSeries[] = []
  for (const [key, g] of groups) {
    // same-day charges (e.g. several loan repayments) are one occurrence
    const byDate = new Map<string, number>()
    for (const t of g)
      byDate.set(t.date, (byDate.get(t.date) ?? 0) + Math.abs(t.amount))
    const occurrences = [...byDate]
      .map(([date, amount]) => ({ date, amount: round2(amount) }))
      .sort((a, b) => a.date.localeCompare(b.date))
    const cadence = detectCadence(occurrences.map((o) => o.date))
    if (!cadence) continue

    const { days } = CADENCE_DAYS[cadence]
    const first = occurrences[0]
    const last = occurrences[occurrences.length - 1]
    const total = sum(occurrences.map((o) => o.amount))
    // each occurrence covers one cadence, so the span runs to a cadence after the last one,
    // capped at the end of the data
    const spanEnd = Math.min(
      daysBetween(first.date, dataEnd) + 1,
      daysBetween(first.date, last.date) + days
    )
    const span = Math.max(spanEnd, days)

    const byAccount = Map.groupBy(g, (t) => t.accountId)
    const accountId = [...byAccount].sort((a, b) => b[1].length - a[1].length)[0][0]

    out.push({
      key,
      categoryId: g[0].categoryId,
      accountId,
      example: g[g.length - 1].description,
      note: g[0].ruleNote,
      direction: directionOf(g[0]),
      cadence,
      occurrences,
      firstDate: first.date,
      lastDate: last.date,
      nextDate: addDays(last.date, days),
      ended: daysBetween(last.date, dataEnd) > days * 1.5 + 7,
      latest: last.amount,
      latestMonthly: round2((last.amount * DAYS_PER_MONTH) / days),
      averageMonthly: round2((total / span) * DAYS_PER_MONTH),
      trend: detectTrend(occurrences),
      total: round2(total),
    })
  }
  return out.sort((a, b) => b.averageMonthly - a.averageMonthly)
}

/**
 * Project one series. Its own override wins; otherwise it follows its category's basis
 * and growth rate, then its own detected trend.
 */
export function projectSeries(
  series: RecurringSeries,
  categoryBasis: DefaultBasis,
  categoryRate: number | null,
  override?: RecurringOverride
): ProjectedSeries {
  let basis: RecurringBasis = override?.basis ?? categoryBasis
  if (basis === "custom" && override?.amount == null) basis = categoryBasis
  const growthRate = override?.growthRate ?? categoryRate ?? series.trend
  const excluded = override?.excluded ?? false

  let monthly: number
  if (basis === "custom") monthly = override!.amount!
  else if (basis === "average") monthly = series.averageMonthly
  else if (basis === "growth")
    monthly = series.latestMonthly * growthFactor(growthRate)
  else monthly = series.latestMonthly

  return {
    ...series,
    basis,
    overridden: override?.basis != null,
    growthRate,
    excluded,
    monthly: excluded || series.ended ? 0 : round2(monthly),
  }
}

export type BudgetLine = {
  key: string
  categoryId: number | null
  direction: 1 | -1
  /** the basis in effect for the category */
  basis: RecurringBasis
  /** set on the category rather than inherited from the page */
  overridden: boolean
  /** your category-wide growth rate, if set */
  growthRate: number | null
  /** detected yearly trend: its items and other spending, weighted by size */
  trend: number
  series: ProjectedSeries[]
  /** projected monthly total of active recurring series */
  recurring: number
  /** everything outside recurring series, refunds netted off: monthly average, median of the last 3 full months, and projected */
  other: { average: number; recent: number; monthly: number }
  /** recurring + other, or your custom amount: the suggested monthly budget */
  projected: number
  /** what the category projects to on each basis, for comparison */
  previews: Record<DefaultBasis, number>
  /** actual net average per month over the window */
  actual: number
}

/** Calendar months (yyyy-MM) lying wholly inside [start, last]. */
function fullMonths(start: string, last: string) {
  const out: string[] = []
  let [y, m] = start.split("-").map(Number)
  if (!start.endsWith("-01")) m++
  for (; ; m++) {
    if (m > 12) {
      y++
      m = 1
    }
    const ym = `${y}-${String(m).padStart(2, "0")}`
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    if (lastDay > last) return out
    out.push(ym)
  }
}

/**
 * Per category: each recurring series projected on its basis, plus everything else in the
 * category. Spending on series that have ended is dropped (it won't recur); series you've
 * marked not recurring count as everything else.
 */
export function buildBudget({
  txs,
  series,
  window,
  defaultBasis,
  overrides,
  categories,
}: {
  txs: RecurringTx[]
  series: RecurringSeries[]
  window: { start: string; last: string; days: number }
  defaultBasis: DefaultBasis
  overrides: Map<string, RecurringOverride>
  categories: Map<number, CategoryProjection>
}): BudgetLine[] {
  const months = Math.max(window.days / DAYS_PER_MONTH, 1)
  const full = fullMonths(window.start, window.last)
  const recentMonths = full.slice(-3)

  const seriesByKey = new Map(series.map((s) => [s.key, s]))
  const groups = new Map<
    string,
    {
      categoryId: number | null
      direction: 1 | -1
      total: number
      other: number
      byMonth: Map<string, { all: number; other: number }>
    }
  >()
  for (const tx of txs) {
    const direction = directionOf(tx)
    const key = lineKey(tx.categoryId, direction)
    const g = groups.get(key) ?? {
      categoryId: tx.categoryId,
      direction,
      total: 0,
      other: 0,
      byMonth: new Map(),
    }
    groups.set(key, g)
    const amount = tx.amount * direction
    const s = seriesByKey.get(seriesKeyOf(tx) ?? "")
    const isOther = !s || (overrides.get(s.key)?.excluded && !s.ended)
    const isEnded = s?.ended && !overrides.get(s.key)?.excluded
    const month = tx.date.slice(0, 7)
    const m = g.byMonth.get(month) ?? { all: 0, other: 0 }
    g.byMonth.set(month, m)
    g.total += amount
    m.all += amount
    if (isOther && !isEnded) {
      g.other += amount
      m.other += amount
    }
  }

  const seriesByLine = Map.groupBy(series, (s) =>
    lineKey(s.categoryId, s.direction)
  )

  return [...groups].map(([key, g]): BudgetLine => {
    const setting =
      g.categoryId !== null ? categories.get(g.categoryId) : undefined
    const rate = setting?.growthRate ?? null
    const average = Math.max(0, g.other / months)
    // occasional spending (most months empty) has no typical month, so use the average
    const activeMonths = full.filter((m) => g.byMonth.get(m)?.other).length
    const other = {
      average,
      // a typical recent month, so one big purchase doesn't set the budget
      recent:
        recentMonths.length && activeMonths * 2 >= full.length
          ? Math.max(
              0,
              median(recentMonths.map((m) => g.byMonth.get(m)?.other ?? 0))
            )
          : average,
    }
    const lineSeries = seriesByLine.get(key) ?? []
    const otherTrend = robustTrend(
      full.map((m) => g.byMonth.get(m)?.other ?? 0)
    )
    // calendar-month totals jump with the number of weekly or fortnightly payments in a
    // month, so the category trend is built from its parts, weighted by their size
    const parts = [
      ...lineSeries
        .filter((s) => !s.ended && !overrides.get(s.key)?.excluded)
        .map((s) => ({ weight: s.latestMonthly, trend: s.trend })),
      { weight: other.recent, trend: otherTrend },
    ]
    const weight = sum(parts.map((x) => x.weight))
    const trend =
      weight > 0 ? sum(parts.map((x) => x.weight * x.trend)) / weight : 0

    // what the whole category comes to on a basis, with merchant overrides still applied
    const projectOn = (basis: DefaultBasis) => {
      const projected = lineSeries.map((s) =>
        projectSeries(s, basis, rate, overrides.get(s.key))
      )
      const otherMonthly =
        basis === "average"
          ? other.average
          : basis === "growth"
            ? other.recent * growthFactor(rate ?? otherTrend)
            : other.recent
      const recurring = sum(projected.map((s) => s.monthly))
      return {
        projected,
        recurring,
        otherMonthly,
        total: recurring + otherMonthly,
      }
    }
    const previews = {
      latest: round2(projectOn("latest").total),
      average: round2(projectOn("average").total),
      growth: round2(projectOn("growth").total),
    }

    const custom = setting?.basis === "custom" && setting.amount != null
    const basis: RecurringBasis = custom
      ? "custom"
      : ((setting?.basis as DefaultBasis | null) ?? defaultBasis)
    // a custom total keeps the breakdown on the page default for reference
    const shown = projectOn(basis === "custom" ? defaultBasis : basis)

    return {
      key,
      categoryId: g.categoryId,
      direction: g.direction,
      basis,
      overridden: setting?.basis != null,
      growthRate: rate,
      trend,
      series: shown.projected,
      recurring: round2(shown.recurring),
      other: {
        average: round2(other.average),
        recent: round2(other.recent),
        monthly: round2(shown.otherMonthly),
      },
      projected: custom ? setting!.amount! : round2(shown.total),
      previews,
      actual: round2(g.total / months),
    }
  })
}
