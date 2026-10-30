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
  /** the plan's own warnings; leave out while it's out of date, as they describe old balances */
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

  if (free >= 0) good.push(`${money(free)} a month is left over after bills, pots and spending`)
  else bad.push(`Spending ${money(-free)} a month more than comes in`)

  const short = sim.potSummaries.filter((p) => p.monthlyIn + 0.5 < p.monthlyOut)
  for (const p of short)
    bad.push(`${p.name} is short ${money(p.monthlyOut - p.monthlyIn)} a month`)
  if (sim.uncovered.length) bad.push(`${plural(sim.uncovered.length, "bill")} not in any pot`)
  if (!short.length && !sim.uncovered.length) good.push("Every bill is funded by a pot")

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
