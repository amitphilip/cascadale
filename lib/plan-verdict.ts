import { differenceInCalendarDays, parseISO } from "date-fns"

import type { CheckInStatus } from "@/lib/checkin-types"
import type { NetWorthPoint } from "@/lib/net-worth"
import type { Simulation } from "@/lib/plan"

/** The plan in plain words: what's going well, what isn't, and how it adds up. Pure. */

export type Verdict = {
  tone: "good" | "watch" | "bad"
  headline: string
  good: string[]
  bad: string[]
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

export function planVerdict({
  sim,
  warnings,
  balanceOf,
  accountName,
  trend,
  money,
  date,
}: {
  sim: Simulation
  /** the plan's own warnings */
  warnings: string[]
  balanceOf: (accountId: number) => number
  accountName: (accountId: number) => string
  /** net worth now and some months ago */
  trend: { months: number; from: NetWorthPoint; to: NetWorthPoint } | null
  money: (n: number) => string
  date: (iso: string) => string
}): Verdict {
  const good: string[] = []
  const bad: string[] = []
  const { free } = sim.monthly

  if (free >= 0)
    good.push(
      `${money(free)} a month is left over after bills, pots and spending`
    )
  else bad.push(`Spending ${money(-free)} a month more than comes in`)

  const short = sim.potSummaries.filter((p) => p.monthlyIn + 0.5 < p.monthlyOut)
  for (const p of short)
    bad.push(`${p.name} is short ${money(p.monthlyOut - p.monthlyIn)} a month`)
  if (sim.uncovered.length)
    bad.push(`${plural(sim.uncovered.length, "bill")} not in any pot`)
  if (!short.length && !sim.uncovered.length)
    good.push("Every bill is funded by a pot")

  const overdrafts = sim.overdrafts.toSorted((a, b) => a.lowest - b.lowest)
  for (const o of overdrafts)
    bad.push(
      balanceOf(o.accountId) < 0
        ? `${accountName(o.accountId)} is overdrawn, down to ${money(o.lowest)}`
        : `${accountName(o.accountId)} goes below zero on ${date(o.date)}, down to ${money(o.lowest)}`
    )
  if (!overdrafts.length) good.push("No account goes below zero")

  if (trend) {
    const worth = trend.to.netWorth - trend.from.netWorth
    const owed = trend.to.debts - trend.from.debts
    const over = `over ${plural(trend.months, "month")}`
    if (worth >= 0) good.push(`Net worth up ${money(worth)} ${over}`)
    else bad.push(`Net worth down ${money(-worth)} ${over}`)
    if (owed >= 0) good.push(`Debts down ${money(owed)} ${over}`)
    else bad.push(`Debts up ${money(-owed)} ${over}`)
  }

  bad.push(...warnings)

  const tone = free < 0 ? "bad" : bad.length ? "watch" : "good"
  const headline = !bad.length
    ? "You’re on track"
    : tone === "bad"
      ? `This plan doesn’t add up: ${plural(bad.length, "thing")} to fix`
      : `${plural(bad.length, "thing")} to look at`
  return { tone, headline, good, bad }
}

/**
 * The verdict with the plan's end goal in it: a line on whether you're heading for it, and
 * the tone no better than the goal's.
 */
export function withGoal(
  verdict: Verdict,
  goal: { tone: CheckInStatus; target: number; gap: number; endDate: string },
  money: (n: number) => string,
  date: (iso: string) => string
): Verdict {
  const tone = GOAL_TONE[goal.tone]
  if (goal.gap >= 0)
    return {
      ...verdict,
      good: [
        `Heading for the goal of ${money(goal.target)} by ${date(goal.endDate)}`,
        ...verdict.good,
      ],
    }
  const worse = TONE_RANK[tone] > TONE_RANK[verdict.tone]
  return {
    tone: worse ? tone : verdict.tone,
    headline: worse
      ? `Heading ${money(-goal.gap)} short of the goal`
      : verdict.headline,
    good: verdict.good,
    bad: [
      `Heading ${money(-goal.gap)} short of the ${money(goal.target)} goal by ${date(goal.endDate)}`,
      ...verdict.bad,
    ],
  }
}

const GOAL_TONE: Record<CheckInStatus, Verdict["tone"]> = {
  on_track: "good",
  watch: "watch",
  off_track: "bad",
}
const TONE_RANK: Record<Verdict["tone"], number> = { good: 0, watch: 1, bad: 2 }

// ── Overall standing ─────────────────────────────────────────────────────────

/** A check-in whose period ended more than this many days of data ago no longer sets the status. */
export const CHECK_IN_FRESH_DAYS = 14

/**
 * How the plan is going, in one status: whether you're following it (the last check-in,
 * which compares what happened with what the plan expected) and whether it holds up
 * (the verdict, from simulating it forward). The worse of the two wins while the check-in
 * is fresh; an old check-in is reported but doesn't set the status.
 */
export type Standing = {
  status: CheckInStatus
  headline: string
  /** days of data after the last check-in's period; null with no check-in yet */
  unchecked: number | null
  /** no check-in, or one too old to speak for today's data */
  stale: boolean
}

const RANK: Record<CheckInStatus, number> = {
  on_track: 0,
  watch: 1,
  off_track: 2,
}
const VERDICT_STATUS: Record<Verdict["tone"], CheckInStatus> = {
  good: "on_track",
  watch: "watch",
  bad: "off_track",
}

export function planStanding({
  verdict,
  checkIn,
  dataEnd,
}: {
  verdict: Verdict
  checkIn: { status: CheckInStatus; headline: string; periodEnd: string } | null
  /** last day with transactions */
  dataEnd: string
}): Standing {
  const unchecked = checkIn
    ? Math.max(
        0,
        differenceInCalendarDays(parseISO(dataEnd), parseISO(checkIn.periodEnd))
      )
    : null
  const stale = unchecked === null || unchecked > CHECK_IN_FRESH_DAYS
  const own = VERDICT_STATUS[verdict.tone]
  const fresh = checkIn && !stale ? checkIn : null
  const status = fresh && RANK[fresh.status] > RANK[own] ? fresh.status : own
  const headline =
    status === "on_track"
      ? "You’re on track"
      : fresh && RANK[fresh.status] >= RANK[own]
        ? fresh.headline
        : verdict.headline
  return { status, headline, unchecked, stale }
}
