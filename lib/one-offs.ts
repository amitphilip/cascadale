// One-off payments: a known total paid out by a finish date, in one go or in parts, with
// the money gathered in a tracking account first. What's been put in and paid out comes
// from the transactions linked to it; the rest is planned from today: what's left to pay is
// split over the payments still to come, and the money each payment needs is split over
// the contributions due before it.

import { addDays, addMonths, format, parseISO } from "date-fns"

import type { OneOff, OneOffFrequency } from "@/lib/db/schema"

export const FREQUENCY_LABELS: Record<OneOffFrequency, string> = {
  week: "Weekly",
  fortnight: "Fortnightly",
  month: "Monthly",
}

export const FREQUENCY_NOUNS: Record<OneOffFrequency, string> = {
  week: "week",
  fortnight: "fortnight",
  month: "month",
}

/** A transaction linked to a one-off: positive is money in for it, negative paid out. */
export type LinkedTx = { id: number; date: string; description: string; amount: number }

/** A planned move of money: into the account for the one-off, or paid out of it. */
export type PlannedMove = {
  date: string
  kind: "in" | "out"
  /** positive */
  amount: number
  /** needed before the next scheduled contribution: put it in now */
  now?: boolean
}

/**
 * paid: nothing left to pay. overdue: the finish date has passed with some left.
 * catch_up: a payment is due before the next scheduled contribution, so money is needed now.
 */
export type OneOffStatus = "paid" | "on_track" | "catch_up" | "overdue"

export type OneOffPlan = {
  /** put in so far, counting what was set aside when it was added */
  paidIn: number
  /** paid out so far, positive */
  paidOut: number
  /** in the account for it now: put in less paid out */
  held: number
  /** still to pay */
  remaining: number
  /** held beyond what's left to pay */
  surplus: number
  /** still to put in, by the plan */
  toPutIn: number
  /** what's left, in date order; on the same day money goes in before it's paid out */
  moves: PlannedMove[]
  status: OneOffStatus
  /** share of the total paid or held, 0–1 */
  progress: number
}

type Plannable = Pick<
  OneOff,
  "total" | "startDate" | "finishDate" | "outMode" | "outEvery" | "inEvery" | "setAside"
>

const iso = (d: Date) => format(d, "yyyy-MM-dd")

/** `date` moved `n` steps of `every` (backwards for negative n), from the date itself so months don't drift. */
export function step(date: string, every: OneOffFrequency, n: number) {
  const d = parseISO(date)
  if (every === "month") return iso(addMonths(d, n))
  return iso(addDays(d, n * (every === "week" ? 7 : 14)))
}

/** Split whole cents as evenly as they go, the odd cents on the first parts. */
function splitCents(cents: number, parts: number) {
  const base = Math.floor(cents / parts)
  const odd = cents - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < odd ? 1 : 0))
}

const toCents = (n: number) => Math.round(n * 100)

/**
 * The dates the remaining payments fall on: the finish date for one paid in one go; for a
 * spread one, every `outEvery` back from the finish date to the start, from today on. Once
 * they've all passed, whatever is left is due today.
 */
export function outDates(o: Plannable, today: string) {
  let dates: string[]
  if (o.outMode === "spread" && o.outEvery) {
    dates = []
    for (let k = 0; ; k++) {
      const d = step(o.finishDate, o.outEvery, -k)
      if (d < o.startDate) break
      dates.unshift(d)
    }
  } else {
    dates = [o.finishDate]
  }
  const ahead = dates.filter((d) => d >= today)
  return ahead.length > 0 ? ahead : [today]
}

/** Contribution dates: every `inEvery` from the start date, from today up to the last payment. */
export function inDates(o: Plannable, today: string, until: string) {
  const dates: string[] = []
  for (let k = 0; ; k++) {
    const d = step(o.startDate, o.inEvery, k)
    if (d > until) break
    if (d >= today) dates.push(d)
  }
  return dates
}

export function planOneOff(o: Plannable, linked: LinkedTx[], today: string): OneOffPlan {
  const inCents =
    toCents(o.setAside) + linked.reduce((s, t) => s + (t.amount > 0 ? toCents(t.amount) : 0), 0)
  const outCents = linked.reduce((s, t) => s + (t.amount < 0 ? -toCents(t.amount) : 0), 0)
  const heldCents = inCents - outCents
  const remainingCents = Math.max(0, toCents(o.total) - outCents)
  const base = {
    paidIn: inCents / 100,
    paidOut: outCents / 100,
    held: heldCents / 100,
    remaining: remainingCents / 100,
    surplus: Math.max(0, heldCents - remainingCents) / 100,
    progress: Math.min(1, (outCents + Math.max(0, heldCents)) / toCents(o.total)),
  }
  if (remainingCents === 0) return { ...base, toPutIn: 0, moves: [], status: "paid" }

  const outs = outDates(o, today)
  const outAmounts = splitCents(remainingCents, outs.length)
  const ins = inDates(o, today, outs[outs.length - 1])

  // Each payment is funded by the contributions since the one before it. One with none of
  // its own is funded by the group before; with no group before, the money is needed now.
  type Group = { dates: string[]; cents: number; now: boolean }
  const groups: Group[] = []
  outs.forEach((date, k) => {
    const from = k === 0 ? today : outs[k - 1]
    const window = ins.filter((d) => (k === 0 ? d >= from : d > from) && d <= date)
    if (window.length > 0) groups.push({ dates: window, cents: outAmounts[k], now: false })
    else if (groups.length > 0) groups[groups.length - 1].cents += outAmounts[k]
    else groups.push({ dates: [today], cents: outAmounts[k], now: true })
  })

  // What's already held pays for the earliest needs first.
  let carry = heldCents
  const moves: PlannedMove[] = []
  for (const g of groups) {
    const need = g.cents - carry
    carry = Math.max(0, -need)
    if (need <= 0) continue
    splitCents(need, g.dates.length).forEach((cents, i) => {
      if (cents > 0) {
        moves.push({ date: g.dates[i], kind: "in", amount: cents / 100, ...(g.now && { now: true }) })
      }
    })
  }
  outs.forEach((date, k) => moves.push({ date, kind: "out", amount: outAmounts[k] / 100 }))
  moves.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "in" ? -1 : 1))

  const toPutIn = moves.reduce((s, m) => s + (m.kind === "in" ? toCents(m.amount) : 0), 0) / 100
  const status: OneOffStatus =
    o.finishDate < today ? "overdue" : moves.some((m) => m.now) ? "catch_up" : "on_track"
  return { ...base, toPutIn, moves, status }
}
