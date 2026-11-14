import {
  addDays,
  addYears,
  differenceInCalendarDays,
  format,
  parseISO,
} from "date-fns"

import {
  ADJUSTMENT_MATCH_DAYS,
  firstsOfMonth,
  flowDates,
  fortnightAnchor,
  type Frequency,
  type PlanPotFund,
  type PlanSnapshot,
} from "@/lib/plan"
import type {
  Actor,
  AdjustmentInstruction,
  PotInstruction,
} from "@/lib/plan-instructions"
import { findFlow } from "@/lib/plan-instructions"

/**
 * Sinking fund pots: money goes in on a schedule (and as top-ups), lumpy known costs are
 * drawn out of it (transactions linked to it, and one-offs planned on it), and it keeps a
 * running balance, what went in, what was spent and what's left of its cap. Its cap and
 * totals can start again every year. Pure functions: the plan service loads the rows.
 */

export const POT_TYPES = ["set_aside", "sinking_fund"] as const
export type PotType = (typeof POT_TYPES)[number]
export const POT_TYPE_LABELS: Record<PotType, string> = {
  set_aside: "Set-aside",
  sinking_fund: "Sinking fund",
}

export const RESET_MODES = ["carry", "release"] as const
export type ResetMode = (typeof RESET_MODES)[number]

export const POT_ENTRY_KINDS = ["contribution", "draw", "planned_draw"] as const
export type PotEntryKind = (typeof POT_ENTRY_KINDS)[number]

/** A row of pot_entries, with its linked transaction as it is now. */
export type PotEntry = {
  id: number
  potId: number
  kind: PotEntryKind
  /** positive as it moves the fund; a linked transaction's own amount wins */
  amount: number
  date: string
  transactionId: number | null
  note: string | null
  /** a scheduled contribution frozen when the pot's schedule changed */
  scheduled: boolean
  createdBy: Actor
  createdAt: string
  transaction: {
    date: string
    description: string
    amount: number
    accountId: number
  } | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const toIso = (d: Date) => format(d, "yyyy-MM-dd")
const dayAfter = (iso: string) => toIso(addDays(parseISO(iso), 1))
const dayBefore = (iso: string) => toIso(addDays(parseISO(iso), -1))

/** What an entry moves the fund by: a draw of a refund is negative, so it gives spend back. */
export function entryAmount(
  e: Pick<PotEntry, "kind" | "amount" | "transaction">
) {
  if (!e.transaction) return e.amount
  return e.kind === "contribution"
    ? e.transaction.amount
    : -e.transaction.amount
}
export const entryDate = (e: Pick<PotEntry, "date" | "transaction">) =>
  e.transaction?.date ?? e.date

/**
 * The days a pot's schedule falls on in [from, to], the same way the simulation places its
 * set-aside: on the funding income's paydays, else every 14 days, else the 1st.
 */
export function scheduleDates(
  pot: Pick<PotInstruction, "frequency" | "incomeKey" | "incomeName">,
  snap: PlanSnapshot,
  from: string,
  to: string
) {
  if (from > to) return []
  const income =
    pot.incomeKey || pot.incomeName
      ? findFlow(snap.incomes, { key: pot.incomeKey, name: pot.incomeName })
      : undefined
  const paydays = (cadence?: string) =>
    income && (!cadence || income.cadence === cadence)
      ? flowDates(income.nextDate, income.cadence, from, to)
      : null
  const f: Frequency = pot.frequency
  if (f === "payday") return paydays() ?? firstsOfMonth(from, to)
  if (f === "fortnightly")
    return (
      paydays("fortnightly") ??
      flowDates(fortnightAnchor(snap), "fortnightly", from, to)
    )
  return paydays("monthly") ?? firstsOfMonth(from, to)
}

/**
 * The fund's scheduled contributions in [from, to]: its amount on each schedule date from
 * scheduledFrom to its end date, with the plan's one-off pot adjustments applied (a skip or
 * changed amount on the nearest date within 3 days, an extra set-aside on its date).
 */
export function scheduledContributions(
  pot: PotInstruction,
  snap: PlanSnapshot,
  adjustments: AdjustmentInstruction[],
  from: string,
  to: string
) {
  const start =
    pot.scheduledFrom && pot.scheduledFrom > from ? pot.scheduledFrom : from
  const end = pot.endDate && pot.endDate < to ? pot.endDate : to
  if (start > end) return []
  const out: { date: string; amount: number; adjustment: number | null }[] =
    pot.amount > 0
      ? scheduleDates(pot, snap, start, end).map((date) => ({
          date,
          amount: pot.amount,
          adjustment: null,
        }))
      : []
  for (const a of adjustments) {
    if (a.target !== "pot" || a.ref?.toLowerCase() !== pot.name.toLowerCase())
      continue
    if (a.date < start || a.date > end) continue
    if (a.kind === "add") {
      if (a.amount)
        out.push({ date: a.date, amount: a.amount, adjustment: a.id })
      continue
    }
    const near = out
      .map((c, i) => ({
        c,
        i,
        gap: Math.abs(
          differenceInCalendarDays(parseISO(c.date), parseISO(a.date))
        ),
      }))
      .filter((x) => x.c.adjustment === null && x.gap <= ADJUSTMENT_MATCH_DAYS)
      .sort((x, y) => x.gap - y.gap)[0]
    if (!near) continue
    if (a.kind === "skip") out.splice(near.i, 1)
    else if (a.amount !== null)
      out[near.i] = { ...near.c, amount: a.amount, adjustment: a.id }
  }
  return out
    .filter((c) => c.amount > 0)
    .sort((x, y) => x.date.localeCompare(y.date))
}

/** The yearly reset dates (anniversaries of resetDate) in [from, to]. */
function resetsBetween(resetDate: string | null, from: string, to: string) {
  if (!resetDate || from > to) return []
  const anchor = parseISO(resetDate)
  const out: string[] = []
  let k = parseISO(from).getFullYear() - anchor.getFullYear() - 1
  for (; ; k++) {
    const date = toIso(addYears(anchor, k))
    if (date > to) return out
    if (date >= from) out.push(date)
  }
}

/** The cycle today is in: from the last reset on or before today to the day before the next. */
export function currentCycle(
  pot: Pick<PotInstruction, "resetDate" | "endDate">,
  today: string
) {
  if (!pot.resetDate) return { start: null, end: pot.endDate, nextReset: null }
  const anchor = parseISO(pot.resetDate)
  let k = parseISO(today).getFullYear() - anchor.getFullYear() + 1
  while (toIso(addYears(anchor, k)) > today) k--
  const start = toIso(addYears(anchor, k))
  const nextReset = toIso(addYears(anchor, k + 1))
  const cycleEnd = dayBefore(nextReset)
  return {
    start,
    end: pot.endDate && pot.endDate < cycleEnd ? pot.endDate : cycleEnd,
    nextReset: pot.endDate && pot.endDate < nextReset ? null : nextReset,
  }
}

export type LedgerLine = {
  date: string
  /** contribution: a top-up or linked transfer in; scheduled: the pot's set-aside; reset: a yearly reset */
  kind: "contribution" | "scheduled" | "draw" | "reset"
  /** signed: positive into the fund, negative out of it */
  amount: number
  /** the fund's balance after this line */
  balance: number
  note: string | null
  entryId: number | null
  transactionId: number | null
}

export type PlannedDraw = {
  entryId: number
  name: string
  amount: number
  date: string
  /** its date has passed and no transaction has been linked for it */
  overdue: boolean
  /** the fund's balance after it, with scheduled contributions until then; below zero is a shortfall */
  balanceAfter: number
}

export type PotAlertKind =
  | "over_cap"
  | "planned_over_cap"
  | "short"
  | "overdue"
  | "ended"
  | "underfunded"

export type PotLedger = {
  pot: {
    id: number
    name: string
    amount: number
    frequency: Frequency
    cap: number | null
    endDate: string | null
    resetDate: string | null
    resetMode: ResetMode
    accountId: number | null
  }
  today: string
  /** the cycle today is in; start null without yearly resets */
  cycle: { start: string | null; end: string | null; nextReset: string | null }
  /** every contribution and draw, oldest first, with the running balance */
  lines: LedgerLine[]
  /** balance carried in at the cycle's start */
  carriedIn: number
  /** this cycle: put in and drawn out */
  contributed: number
  spent: number
  balance: number
  cap: {
    amount: number
    /** spent in this cycle */
    used: number
    /** cap less spent */
    remaining: number
    /** cap less spent and planned draws */
    remainingAfterPlanned: number
    usedPct: number
  } | null
  plannedDraws: PlannedDraw[]
  plannedTotal: number
  nextDraw: PlannedDraw | null
  /** the largest gap between the balance and a planned draw it has to pay; 0 when covered */
  shortfall: number
  /** what to set aside each time to reach the cap (or the planned total) by the end */
  suggestion: {
    /** cap, or spent plus planned draws */
    target: number
    /** what still has to go in: target less spent less balance */
    need: number
    frequency: Frequency
    /** schedule dates left until the end */
    periods: number
    until: string | null
    perPeriod: number | null
    /** each period's amount as a month's */
    perMonth: number | null
    /** the pot's amount covers it */
    onTrack: boolean
  } | null
  linked: { count: number; drawn: number; contributed: number }
  /** what needs attention, by kind; warnings is their messages */
  alerts: { kind: PotAlertKind; message: string }[]
  warnings: string[]
  ended: boolean
}

const TIMES_A_MONTH: Record<string, number> = {
  weekly: 52 / 12,
  fortnightly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
}

/** How many times a month the pot's schedule falls. */
function timesAMonth(pot: PotInstruction, snap: PlanSnapshot) {
  if (pot.frequency === "fortnightly") return TIMES_A_MONTH.fortnightly
  if (pot.frequency === "monthly") return 1
  const income =
    pot.incomeKey || pot.incomeName
      ? findFlow(snap.incomes, { key: pot.incomeKey, name: pot.incomeName })
      : undefined
  return income ? TIMES_A_MONTH[income.cadence] : 1
}

/** A sinking fund's ledger, totals, cap, planned draws and suggested contribution, as of today. */
export function potLedger({
  pot,
  entries,
  snap,
  adjustments,
  today,
  money = (n) => n.toFixed(2),
}: {
  pot: PotInstruction
  entries: PotEntry[]
  snap: PlanSnapshot
  adjustments: AdjustmentInstruction[]
  today: string
  money?: (n: number) => string
}): PotLedger {
  const mine = entries.filter((e) => e.potId === pot.id)
  const booked = mine.filter((e) => e.kind !== "planned_draw")
  const first = [
    ...booked.map(entryDate),
    ...(pot.scheduledFrom ? [pot.scheduledFrom] : []),
  ].sort()[0]
  const scheduled = first
    ? scheduledContributions(pot, snap, adjustments, first, today)
    : []
  const resets = first
    ? resetsBetween(pot.resetDate, dayAfter(first), today)
    : []

  type Raw = Omit<LedgerLine, "balance">
  const raw: Raw[] = [
    ...booked.map((e): Raw => ({
      date: entryDate(e),
      kind:
        e.kind === "draw" ? "draw" : e.scheduled ? "scheduled" : "contribution",
      amount: round2(e.kind === "draw" ? -entryAmount(e) : entryAmount(e)),
      note: e.transaction?.description ?? e.note,
      entryId: e.id,
      transactionId: e.transactionId,
    })),
    ...scheduled.map((c): Raw => ({
      date: c.date,
      kind: "scheduled",
      amount: c.amount,
      note: c.adjustment
        ? `Scheduled, adjusted (adjustment ${c.adjustment})`
        : "Scheduled",
      entryId: null,
      transactionId: null,
    })),
  ]
  // money in before money out on a day; a reset opens its day
  const order = { reset: 0, scheduled: 1, contribution: 2, draw: 3 }
  raw.sort(
    (a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]
  )

  const lines: LedgerLine[] = []
  let balance = 0
  let r = 0
  const pushReset = (date: string) => {
    const released =
      pot.resetMode === "release" && balance > 0 ? round2(-balance) : 0
    balance = round2(balance + released)
    lines.push({
      date,
      kind: "reset",
      amount: released,
      balance,
      note: released
        ? `Yearly reset: ${money(-released)} released`
        : `Yearly reset: ${money(balance)} carried over`,
      entryId: null,
      transactionId: null,
    })
  }
  for (const line of raw) {
    while (r < resets.length && resets[r] <= line.date) pushReset(resets[r++])
    balance = round2(balance + line.amount)
    lines.push({ ...line, balance })
  }
  while (r < resets.length) pushReset(resets[r++])

  const cycle = currentCycle(pot, today)
  const inCycle = (date: string) =>
    (!cycle.start || date >= cycle.start) && date <= today
  const resetLine = cycle.start
    ? lines.findLast((l) => l.kind === "reset" && l.date === cycle.start)
    : undefined
  const carriedIn = resetLine?.balance ?? 0
  const contributed = round2(
    lines
      .filter((l) => l.kind !== "draw" && l.kind !== "reset" && inCycle(l.date))
      .reduce((s, l) => s + l.amount, 0)
  )
  const spent = round2(
    -lines
      .filter((l) => l.kind === "draw" && inCycle(l.date))
      .reduce((s, l) => s + l.amount, 0)
  )

  // planned draws, paid in date order from the balance and the contributions due by then
  const horizon =
    cycle.end ??
    mine
      .filter((e) => e.kind === "planned_draw")
      .map((e) => e.date)
      .sort()
      .at(-1) ??
    today
  const upcoming = scheduledContributions(
    pot,
    snap,
    adjustments,
    dayAfter(today),
    horizon
  )
  let projected = balance
  let c = 0
  const plannedDraws = mine
    .filter((e) => e.kind === "planned_draw")
    .filter((e) => !cycle.nextReset || e.date < cycle.nextReset)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .map((e): PlannedDraw => {
      for (; c < upcoming.length && upcoming[c].date <= e.date; c++)
        projected += upcoming[c].amount
      projected = round2(projected - e.amount)
      return {
        entryId: e.id,
        name: e.note ?? "Planned draw",
        amount: e.amount,
        date: e.date,
        overdue: e.date < today,
        balanceAfter: projected,
      }
    })
  const plannedTotal = round2(plannedDraws.reduce((s, d) => s + d.amount, 0))
  const nextDraw = plannedDraws[0] ?? null
  const shortfall = round2(
    Math.max(0, ...plannedDraws.map((d) => -d.balanceAfter))
  )

  const cap =
    pot.capAmount === null
      ? null
      : {
          amount: pot.capAmount,
          used: spent,
          remaining: round2(pot.capAmount - spent),
          remainingAfterPlanned: round2(pot.capAmount - spent - plannedTotal),
          usedPct: Math.round((spent / pot.capAmount) * 1000) / 10,
        }

  const target = pot.capAmount ?? round2(spent + plannedTotal)
  const need = round2(Math.max(0, target - spent - balance))
  const suggestUntil = cycle.end ?? plannedDraws.at(-1)?.date ?? null
  const periods = suggestUntil
    ? scheduleDates(pot, snap, dayAfter(today), suggestUntil).length
    : 0
  const perPeriod = periods > 0 ? Math.ceil((need / periods) * 100) / 100 : null
  const suggestion =
    target > 0
      ? {
          target,
          need,
          frequency: pot.frequency,
          periods,
          until: suggestUntil,
          perPeriod,
          perMonth:
            perPeriod === null
              ? null
              : round2(perPeriod * timesAMonth(pot, snap)),
          onTrack:
            need === 0 ||
            (perPeriod !== null && pot.amount >= perPeriod - 0.005),
        }
      : null

  const linkedEntries = booked.filter((e) => e.transaction)
  const linked = {
    count: linkedEntries.length,
    drawn: round2(
      linkedEntries
        .filter((e) => e.kind === "draw")
        .reduce((s, e) => s + entryAmount(e), 0)
    ),
    contributed: round2(
      linkedEntries
        .filter((e) => e.kind === "contribution")
        .reduce((s, e) => s + entryAmount(e), 0)
    ),
  }

  const ended = !!pot.endDate && pot.endDate < today
  const alerts: PotLedger["alerts"] = []
  const warn = (kind: PotAlertKind, message: string) =>
    alerts.push({ kind, message })
  const label = `Sinking fund "${pot.name}"`
  if (cap && spent > cap.amount + 0.005)
    warn(
      "over_cap",
      `${label} is ${money(spent - cap.amount)} over its ${money(cap.amount)} cap`
    )
  else if (cap && cap.remainingAfterPlanned < -0.005)
    warn(
      "planned_over_cap",
      `${label}: spent and planned draws come to ${money(spent + plannedTotal)}, ${money(-cap.remainingAfterPlanned)} over its ${money(cap.amount)} cap`
    )
  if (nextDraw && nextDraw.balanceAfter < -0.005)
    warn(
      "short",
      `${label} won't cover its next planned draw, ${nextDraw.name} on ${nextDraw.date}: ${money(-nextDraw.balanceAfter)} short`
    )
  else if (shortfall > 0.005)
    warn(
      "short",
      `${label} runs ${money(shortfall)} short of a later planned draw`
    )
  for (const d of plannedDraws.filter((x) => x.overdue))
    warn(
      "overdue",
      `${label}: planned draw ${d.name} on ${d.date} has passed; link its transaction or remove it`
    )
  if (ended && plannedDraws.some((d) => !d.overdue))
    warn(
      "ended",
      `${label} ended on ${pot.endDate} but still has planned draws`
    )
  if (
    suggestion &&
    !suggestion.onTrack &&
    suggestion.perPeriod !== null &&
    !ended
  )
    warn(
      "underfunded",
      `${label} needs ${money(suggestion.perPeriod)} ${pot.frequency === "payday" ? "each payday" : pot.frequency === "fortnightly" ? "a fortnight" : "a month"} to reach ${money(target)} by ${suggestion.until}${pot.amount > 0 ? `; it gets ${money(pot.amount)}` : "; nothing is scheduled"}`
    )

  return {
    pot: {
      id: pot.id,
      name: pot.name,
      amount: pot.amount,
      frequency: pot.frequency,
      cap: pot.capAmount,
      endDate: pot.endDate,
      resetDate: pot.resetDate,
      resetMode: pot.resetMode,
      accountId: pot.toAccountId ?? pot.fromAccountId,
    },
    today,
    cycle,
    lines,
    carriedIn,
    contributed,
    spent,
    balance,
    cap,
    plannedDraws,
    plannedTotal,
    nextDraw,
    shortfall,
    suggestion,
    linked,
    alerts,
    warnings: alerts.map((a) => a.message),
    ended,
  }
}

/** A fund's health in a few numbers, as check-ins and briefings report it. */
export function potHealth(l: PotLedger) {
  return {
    pot: l.pot.name,
    balance: l.balance,
    contributed: l.contributed,
    spent: l.spent,
    cap: l.cap?.amount ?? null,
    capUsedPct: l.cap?.usedPct ?? null,
    capRemaining: l.cap?.remaining ?? null,
    plannedTotal: l.plannedTotal,
    nextDraw: l.nextDraw && {
      name: l.nextDraw.name,
      date: l.nextDraw.date,
      amount: l.nextDraw.amount,
    },
    shortfall: l.shortfall,
    suggestedContribution: l.suggestion?.perPeriod ?? null,
    frequency: l.pot.frequency,
    endDate: l.pot.endDate,
    warnings: l.warnings,
  }
}
export type PotHealth = ReturnType<typeof potHealth>

/** A fund as the simulation takes it. */
export const potFund = (l: PotLedger): PlanPotFund => ({
  pot: l.pot.name,
  balance: l.balance,
  asOf: l.today,
  accountId: l.pot.accountId,
  until: l.pot.endDate,
  draws: l.plannedDraws.map((d) => ({
    id: `D${d.entryId}`,
    name: d.name,
    date: d.date,
    amount: d.amount,
  })),
})
