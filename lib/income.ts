import {
  CADENCE_DAYS,
  seriesKeyOf,
  type RecurringOverride,
  type RecurringSeries,
  type RecurringTx,
} from "@/lib/recurring"

/**
 * Income growth. Pure functions: income is split into regular pay (recurring series) and
 * one-offs (everything off-schedule, plus bonuses paid on top of a regular payment). Growth
 * is measured on the regular part only, as a monthly run rate (the average payment over the
 * last three months, scaled to a month) so that months with three fortnightly pays or a
 * quarterly payment don't read as a raise. The run rate is worked out over all of history
 * and then reported for the range asked for, so the range doesn't change the figures.
 */

const DAYS_PER_MONTH = 365.25 / 12
/** A payment this far above its neighbours' typical amount carries a bonus on top. */
const BONUS_RATIO = 1.5
/** Neighbouring payments either side that set the typical amount. */
const NEIGHBOURS = 3
/** Days of regular pay averaged into the run rate, so variable pay doesn't swing it. */
const RATE_DAYS = 91
/** Grace after a missed payday before a source counts as paused. */
const PAUSE_GRACE = 7

export type OneOff = {
  date: string
  description: string
  categoryId: number | null
  amount: number
  /** part of a regular source: a bonus on top of a payment, or an extra payment between paydays */
  kind: "bonus" | "extra" | null
  /** for a bonus: the usual payment it came on top of */
  usual: number | null
}

export type IncomeMonth = {
  month: string
  /** regular pay received this month */
  regular: number
  /** one-offs received this month */
  oneOff: number
  /** regular pay as a monthly run rate: what the active series come to per month */
  rate: number
  /** change in rate from the previous month */
  mom: number | null
  /** change in rate from the same month a year earlier */
  yoy: number | null
}

export type IncomeYear = {
  year: string
  months: number
  regular: number
  oneOff: number
  /** average monthly run rate across the year's months */
  rate: number
  /** change in average rate from the previous year */
  growth: number | null
}

export type IncomeSource = {
  series: RecurringSeries
  /** you marked it not recurring: its payments count as one-offs */
  excluded: boolean
  /** first and latest regular payments, bonuses taken out */
  first: number
  latest: number
  change: number | null
  /** latest regular payment as a monthly figure; 0 once stopped or excluded */
  monthly: number
}

export type IncomeAnalysis = {
  months: IncomeMonth[]
  years: IncomeYear[]
  sources: IncomeSource[]
  oneOffs: OneOff[]
  /** yearly growth of the run rate, null under 3 months */
  trend: number | null
}

const lastDayOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const round2 = (n: number) => Math.round(n * 100) / 100
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
const growth = (now: number, then: number | undefined) =>
  then && then > 0 && now > 0 ? now / then - 1 : null

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Money in: income categories (reversals included) and uncategorized deposits. */
export function isIncome(tx: RecurringTx) {
  return tx.categoryKind === "income" || (tx.categoryKind === null && tx.amount > 0)
}

/** Calendar months (yyyy-MM) from the month of `start` to the month of `last`. */
export function monthsBetween(start: string, last: string) {
  const out: string[] = []
  let [y, m] = start.split("-").map(Number)
  const end = last.slice(0, 7)
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`
    if (ym > end) return out
    out.push(ym)
    if (++m > 12) {
      y++
      m = 1
    }
  }
}

/**
 * Yearly growth of the run rate, compounded from the typical early months to the typical
 * recent ones. Pay tends to step up rather than drift, so this compares levels instead of
 * fitting a slope. Spans under a year count as a year, so one raise isn't annualized up.
 */
function annualTrend(values: number[]) {
  const start = values.findIndex((v) => v > 0)
  const xs = start < 0 ? [] : values.slice(start)
  if (xs.length < 3) return null
  const k = Math.max(1, Math.min(3, Math.floor(xs.length / 3)))
  const early = median(xs.slice(0, k))
  const late = median(xs.slice(-k))
  if (early <= 0 || late <= 0) return null
  const years = Math.max(1, (xs.length - k) / 12)
  return (late / early) ** (1 / years) - 1
}

/**
 * Split each payment in a series into its regular part and anything on top. A bonus stands
 * out from the typical payments both before and after it (a raise only from those before);
 * an extra payment lands well before the next payday is due.
 */
function splitPayments(s: RecurringSeries) {
  const occ = s.occurrences.map((o) => o.amount)
  const typical = (xs: number[]) => (xs.length ? median(xs) : null)
  const gap = CADENCE_DAYS[s.cadence].min / 2
  return s.occurrences.map((o, i) => {
    const prior = occ.slice(Math.max(0, i - NEIGHBOURS), i)
    const next = occ.slice(i + 1, i + 1 + NEIGHBOURS)
    const usual = typical([...prior, ...next]) ?? o.amount
    if (i > 0 && daysBetween(s.occurrences[i - 1].date, o.date) < gap)
      return { date: o.date, regular: 0, extra: o.amount, kind: "extra" as const, usual }
    const before = typical(prior)
    const after = typical(next)
    const bonus =
      before !== null &&
      o.amount > before * BONUS_RATIO &&
      (after === null || o.amount > after * BONUS_RATIO)
    return {
      date: o.date,
      regular: bonus ? usual : o.amount,
      extra: bonus ? round2(o.amount - usual) : 0,
      kind: bonus ? ("bonus" as const) : null,
      usual,
    }
  })
}

export function analyzeIncome({
  txs,
  series,
  overrides,
  start,
  end,
  from,
}: {
  /** all income transactions (see isIncome) */
  txs: RecurringTx[]
  /** recurring series detected over the same transactions */
  series: RecurringSeries[]
  overrides: Map<string, RecurringOverride>
  /** first and last days with data */
  start: string
  end: string
  /** first day of the range to report */
  from: string
}): IncomeAnalysis {
  const months = monthsBetween(start, end)
  const index = new Map(months.map((m, i) => [m, i]))
  const incomeSeries = series.filter((s) => s.direction > 0)
  const activeKeys = new Set(
    incomeSeries.filter((s) => !overrides.get(s.key)?.excluded).map((s) => s.key)
  )

  const regular = months.map(() => 0)
  const oneOff = months.map(() => 0)
  const rate = months.map(() => 0)
  const oneOffs: OneOff[] = []
  const sources: IncomeSource[] = []
  const addOneOff = (o: OneOff) => {
    oneOff[index.get(o.date.slice(0, 7))!] += o.amount
    if (o.date >= from) oneOffs.push(o)
  }

  for (const tx of txs) {
    if (activeKeys.has(seriesKeyOf(tx) ?? "")) continue
    addOneOff({
      date: tx.date,
      description: tx.description,
      categoryId: tx.categoryId,
      amount: tx.amount,
      kind: null,
      usual: null,
    })
  }

  for (const s of incomeSeries) {
    const payments = splitPayments(s)
    const excluded = !activeKeys.has(s.key)
    const { days, max } = CADENCE_DAYS[s.cadence]
    const perMonth = DAYS_PER_MONTH / days
    const scheduled = payments.filter((p) => p.kind !== "extra")
    const shown = scheduled.filter((p) => p.date >= from)
    if (shown.length) {
      const first = shown[0].regular
      const latest = shown[shown.length - 1].regular
      sources.push({
        series: s,
        excluded,
        first: round2(first),
        latest: round2(latest),
        change: growth(latest, first),
        monthly: excluded || s.ended ? 0 : round2(latest * perMonth),
      })
    }
    if (excluded) continue

    // regular pay received, bonuses and extra payments split out as one-offs
    for (const p of payments) {
      regular[index.get(p.date.slice(0, 7))!] += p.regular
      if (p.extra > 0)
        addOneOff({
          date: p.date,
          description: s.example,
          categoryId: s.categoryId,
          amount: p.extra,
          kind: p.kind,
          usual: p.kind === "bonus" ? round2(p.usual) : null,
        })
    }

    // run rate at each month end: the average payment over the last three months, or 0 once
    // a payday has been missed. A series already running when the data starts is backfilled.
    const running = daysBetween(start, s.firstDate) <= max
    months.forEach((m, i) => {
      const asOf = i === months.length - 1 ? end : lastDayOf(m)
      const paid = scheduled.filter((p) => p.date <= asOf)
      const last = paid.at(-1)
      let payment = 0
      if (!last) payment = running ? scheduled[0].regular : 0
      else if (daysBetween(last.date, asOf) <= max + PAUSE_GRACE) {
        const recent = paid.filter((p) => daysBetween(p.date, asOf) < RATE_DAYS)
        payment = sum(recent.map((p) => p.regular)) / recent.length
      }
      rate[i] += payment * perMonth
    })
  }

  const all = months.map(
    (month, i): IncomeMonth => ({
      month,
      regular: round2(regular[i]),
      oneOff: round2(oneOff[i]),
      rate: round2(rate[i]),
      mom: i > 0 ? growth(rate[i], rate[i - 1]) : null,
      yoy: i >= 12 ? growth(rate[i], rate[i - 12]) : null,
    })
  )
  const rows = all.filter((r) => r.month >= from.slice(0, 7))

  const years: IncomeYear[] = []
  for (const [year, ys] of Map.groupBy(rows, (m) => m.month.slice(0, 4))) {
    const avg = sum(ys.map((r) => r.rate)) / ys.length
    years.push({
      year,
      months: ys.length,
      regular: round2(sum(ys.map((r) => r.regular))),
      oneOff: round2(sum(ys.map((r) => r.oneOff))),
      rate: round2(avg),
      growth: growth(avg, years.at(-1)?.rate),
    })
  }

  return {
    months: rows,
    years,
    sources: sources.sort((a, b) => b.monthly - a.monthly || b.series.total - a.series.total),
    oneOffs: oneOffs.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount),
    trend: annualTrend(rows.map((r) => r.rate)),
  }
}
