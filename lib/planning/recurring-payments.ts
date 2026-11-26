// Recurring payments: what goes out of the household's accounts on a schedule. Pure, so the
// MCP tools and the tests agree.
//
// Outgoing transactions are grouped by the account they leave and what they pay:
// - a transfer into another household account (both sides synced, paired by amount and date)
//   is keyed "to:<account id>", so a credit card payment or the mortgage move is one series
//   whatever the bank calls it;
// - anything else by its counterparty (lib/recurring.ts counterpartyKey: the merchant key
//   with channel words such as "TFR TO" dropped), so "TFR TO Magic Kingdom" each week is one.
// Same-day amounts in a group are one occurrence (a loan repayment in six parts). A group is
// recurring when the gaps between occurrences sit on a weekly, fortnightly, monthly or
// quarterly cadence; it's dropped once it's well past its next date.

import { counterpartyKey } from "@/lib/recurring"
import { merchantName } from "@/supabase/functions/_shared/cas-queue"
import { pairTransfers } from "@/supabase/functions/_shared/transfers"

export const PAYMENT_CADENCES = ["weekly", "fortnightly", "monthly", "quarterly"] as const
export type PaymentCadence = (typeof PAYMENT_CADENCES)[number]

/** A loan or mortgage repayment, whatever part of it the loan account shows. */
const LOAN_WORDS = /\b(loan|mortgage|home ?loan)\b/i

/**
 * What a payment out is grouped by: the account a transfer went into, else its counterparty.
 * A loan repayment goes by its counterparty even when part of it pairs with a loan account:
 * the loan account shows the principal, not the interest, so pairing would split one
 * repayment into a series per part.
 */
export function groupKey(t: Pick<PaymentTx, "description">, pairedTo: number | undefined) {
  if (pairedTo !== undefined && !LOAN_WORDS.test(t.description)) return `to:${pairedTo}`
  return counterpartyKey(t.description)
}

/** Typical days between payments, and the gaps that count as on cadence. */
export const CADENCE: Record<PaymentCadence, { days: number; min: number; max: number; perMonth: number }> = {
  weekly: { days: 7, min: 5, max: 9, perMonth: 52 / 12 },
  fortnightly: { days: 14, min: 12, max: 16, perMonth: 26 / 12 },
  monthly: { days: 365.25 / 12, min: 26, max: 35, perMonth: 1 },
  quarterly: { days: 365.25 / 4, min: 84, max: 98, perMonth: 1 / 3 },
}

/** Share of gaps that must sit on the cadence. */
const REGULARITY = 0.6
/** Amounts within this share of the median are the same payment. */
const AMOUNT_BAND = 0.2
/** A payment this far past its next date has probably stopped. */
const ENDED_GRACE_DAYS = 7

export type PaymentTx = {
  id: number
  accountId: number
  date: string
  description: string
  /** signed: negative is money out */
  amount: number
  categoryId: number | null
}

export type PaymentAccount = {
  id: number
  name: string
  type: string
  /** whose it is; null for joint */
  holderId: string | null
}

export type RecurringPayment = {
  /** "<from account id>|<matchKey>", unique in the list */
  key: string
  /** the merchant key, or "to:<account id>" for a transfer into a household account */
  matchKey: string
  name: string
  /** the latest payment's description, as the bank gives it */
  example: string
  kind: "payment" | "transfer"
  fromAccountId: number
  fromAccount: string
  /** whose account it leaves: a member's id, null for joint */
  ownerId: string | null
  /** the owner's name, or "Joint" */
  owner: string
  /** for a transfer: the household account it goes into */
  toAccountId: number | null
  toAccount: string | null
  /** the category most of its payments carry */
  categoryId: number | null
  cadence: PaymentCadence
  /** the median payment, positive */
  typicalAmount: number
  lastAmount: number
  minAmount: number
  maxAmount: number
  /** amounts spread more than 20% from the typical one (a power bill, a card payment) */
  amountVaries: boolean
  /** typical amount as a monthly figure */
  monthly: number
  count: number
  firstDate: string
  lastDate: string
  nextExpected: string
  /** the next payment's date has passed */
  overdue: boolean
  /** high: 4+ on cadence and steady; low: only two seen */
  confidence: "high" | "medium" | "low"
}

const DAY = 86_400_000
const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY)
export const addDays = (iso: string, days: number) =>
  new Date(toTime(iso) + Math.round(days) * DAY).toISOString().slice(0, 10)
const round2 = (n: number) => Math.round(n * 100) / 100 + 0

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The date `months` calendar months before `today`. */
export function monthsBefore(today: string, months: number) {
  const [y, m, d] = today.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1 - months, d))
  return date.toISOString().slice(0, 10)
}

function cadenceOf(dates: string[], amounts: number[]): PaymentCadence | null {
  if (dates.length < 2) return null
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d))
  const typical = median(gaps)
  for (const cadence of PAYMENT_CADENCES) {
    const { min, max } = CADENCE[cadence]
    if (typical < min || typical > max) continue
    // weekly and fortnightly need three to tell from chance; two months or quarters will do
    // when the amounts agree
    const needed = cadence === "weekly" || cadence === "fortnightly" ? 3 : 2
    if (dates.length < needed) return null
    if (dates.length === 2) {
      const [a, b] = amounts
      if (Math.abs(a - b) > AMOUNT_BAND * Math.max(a, b)) return null
    }
    const regular = gaps.filter((g) => g >= min && g <= max).length
    return regular / gaps.length >= REGULARITY ? cadence : null
  }
  return null
}

/**
 * The household's recurring payments over the `months` before `today`, biggest monthly
 * first. `names` gives each member's name by id.
 */
export function detectRecurringPayments(input: {
  txs: PaymentTx[]
  accounts: PaymentAccount[]
  names: Map<string, string>
  today: string
  months: number
}): RecurringPayment[] {
  const { today } = input
  const from = monthsBefore(today, input.months)
  const txs = input.txs.filter((t) => t.date >= from && t.date <= today)
  const account = new Map(input.accounts.map((a) => [a.id, a]))
  // pair over every account, so a transfer's other side is found wherever it landed
  const toAccount = new Map(pairTransfers(txs).map((p) => [p.outId, p.toAccountId]))

  const groups = new Map<string, { fromAccountId: number; matchKey: string; txs: PaymentTx[] }>()
  for (const t of txs) {
    if (t.amount >= 0 || !account.has(t.accountId)) continue
    const to = toAccount.get(t.id)
    const matchKey = groupKey(t, to)
    const key = `${t.accountId}|${matchKey}`
    const g = groups.get(key) ?? { fromAccountId: t.accountId, matchKey, txs: [] }
    g.txs.push(t)
    groups.set(key, g)
  }

  const out: RecurringPayment[] = []
  for (const [key, g] of groups) {
    const byDate = new Map<string, number>()
    for (const t of g.txs) byDate.set(t.date, (byDate.get(t.date) ?? 0) - t.amount)
    const occ = [...byDate].sort((a, b) => a[0].localeCompare(b[0]))
    const dates = occ.map(([d]) => d)
    const amounts = occ.map(([, a]) => round2(a))
    const cadence = cadenceOf(dates, amounts)
    if (!cadence) continue

    const { days, perMonth } = CADENCE[cadence]
    const lastDate = dates.at(-1)!
    const nextExpected = addDays(lastDate, days)
    // well past when it should have come again: it's stopped
    if (daysBetween(nextExpected, today) > days * 0.5 + ENDED_GRACE_DAYS) continue

    const typical = round2(median(amounts))
    const min = Math.min(...amounts)
    const max = Math.max(...amounts)
    const varies = max - typical > AMOUNT_BAND * typical || typical - min > AMOUNT_BAND * typical
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d))
    const onCadence = gaps.filter((x) => x >= CADENCE[cadence].min && x <= CADENCE[cadence].max).length
    const confidence =
      dates.length === 2 ? "low" : dates.length >= 4 && onCadence === gaps.length && !varies ? "high" : "medium"

    const fromAcc = account.get(g.fromAccountId)!
    // a loan repayment keyed by its counterparty still goes into the loan its parts pair with
    const pairedTo = new Map<number, number>()
    for (const t of g.txs) {
      const to = toAccount.get(t.id)
      if (to !== undefined) pairedTo.set(to, (pairedTo.get(to) ?? 0) + 1)
    }
    const toId = g.matchKey.startsWith("to:")
      ? Number(g.matchKey.slice(3))
      : ([...pairedTo].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
    const toAcc = toId === null ? undefined : account.get(toId)
    const categories = new Map<number | null, number>()
    for (const t of g.txs) categories.set(t.categoryId, (categories.get(t.categoryId) ?? 0) + 1)
    const categoryId = [...categories].sort((a, b) => b[1] - a[1])[0][0]

    const example = g.txs.reduce((a, b) => (b.date >= a.date ? b : a)).description
    out.push({
      key,
      matchKey: g.matchKey,
      // a description that's all references has no merchant words: show it as the bank does
      name: g.matchKey.startsWith("to:") ? `Transfer to ${toAcc?.name ?? "another account"}` : /\d/.test(g.matchKey) ? example : merchantName(g.matchKey),
      example,
      kind: g.matchKey.startsWith("to:") ? "transfer" : "payment",
      fromAccountId: g.fromAccountId,
      fromAccount: fromAcc.name,
      ownerId: fromAcc.holderId,
      owner: fromAcc.holderId === null ? "Joint" : (input.names.get(fromAcc.holderId) ?? "Someone"),
      toAccountId: toId,
      toAccount: toAcc?.name ?? null,
      categoryId,
      cadence,
      typicalAmount: typical,
      lastAmount: amounts.at(-1)!,
      minAmount: round2(min),
      maxAmount: round2(max),
      amountVaries: varies,
      monthly: round2(typical * perMonth),
      count: dates.length,
      firstDate: dates[0],
      lastDate,
      nextExpected,
      overdue: nextExpected < today,
      confidence,
    })
  }
  return out.sort((a, b) => b.monthly - a.monthly || a.key.localeCompare(b.key))
}

/** A recurring payment's dates from `from` (inclusive) to `to` (exclusive). */
export function datesBetween(p: Pick<RecurringPayment, "nextExpected" | "cadence">, from: string, to: string) {
  const { days } = CADENCE[p.cadence]
  const out = new Set<string>()
  for (let k = 0; ; k++) {
    const d = addDays(p.nextExpected, days * k)
    if (d >= to) break
    // an overdue one is still expected: once, from `from`
    out.add(d < from ? from : d)
  }
  return [...out]
}
