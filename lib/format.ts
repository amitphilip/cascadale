export type MoneyFormat = { currency: string; locale: string }

export function formatMoney(
  amount: number,
  { currency, locale }: MoneyFormat,
  opts: { signed?: boolean; compact?: boolean } = {}
) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    signDisplay: opts.signed ? "exceptZero" : "auto",
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: opts.compact ? 1 : 2,
  }).format(amount)
}

export function formatDate(iso: string, locale: string) {
  const [y, m, d] = iso.split("-").map(Number)
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(y, m - 1, d))
}

/** "September 2026", or "Sep ’26" when short. */
export function formatMonth(ym: string, locale: string, short = false) {
  const [y, m] = ym.split("-").map(Number)
  const date = new Date(y, m - 1, 1)
  if (!short) {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(date)
  }
  const month = new Intl.DateTimeFormat(locale, { month: "short" }).format(date)
  return `${month} ’${String(y).slice(2)}`
}

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  investment: "Investment",
  loan: "Loan",
  cash: "Cash",
  other: "Other",
}

export const CATEGORY_KIND_LABELS: Record<string, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
}

export const PERIODS = ["week", "fortnight", "month", "year"] as const
export type Period = (typeof PERIODS)[number]

export const PERIOD_LABELS: Record<Period, string> = {
  week: "Weekly",
  fortnight: "Fortnightly",
  month: "Monthly",
  year: "Yearly",
}

export const PERIOD_SUFFIX: Record<Period, string> = {
  week: "/wk",
  fortnight: "/fn",
  month: "/mo",
  year: "/yr",
}

/** Multiplier that turns a monthly amount into an estimate for the given period. */
const PER_MONTH: Record<Period, number> = { week: 12 / 52, fortnight: 12 / 26, month: 1, year: 12 }

export function fromMonthly(amount: number, period: Period) {
  return amount * PER_MONTH[period]
}

const PERIOD_DAYS: Record<Period, number> = {
  week: 7,
  fortnight: 14,
  month: 365.25 / 12,
  year: 365.25,
}

/** Average per period of a total accumulated over `days` days. */
export function perPeriod(total: number, days: number, period: Period) {
  return (total / days) * PERIOD_DAYS[period]
}

export function parsePeriod(value: string | undefined): Period {
  return PERIODS.includes(value as Period) ? (value as Period) : "month"
}

/** Chart series colors in fixed order; keep each entity on the same slot. */
export const SERIES_COLORS = [1, 2, 3, 4, 5].map((n) => `var(--chart-${n})`)
