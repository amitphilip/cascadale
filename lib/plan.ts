import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
  parseISO,
} from "date-fns"
import { z } from "zod"

import {
  CADENCE_DAYS,
  seriesKeyOf,
  type BudgetLine,
  type Cadence,
  type RecurringOverride,
  type RecurringSeries,
  type RecurringTx,
} from "@/lib/recurring"

/**
 * Cash planning: which income should set aside how much, into which pot, so each bill is
 * funded by the time it is due. The model writes the plan; this module builds what it is
 * given (a snapshot of income, bills and spending, each tied to its account) and simulates
 * a plan day by day to show whether it holds up. Pure functions.
 */

const DAYS_PER_MONTH = 365.25 / 12
/** How far ahead plans are simulated. */
export const HORIZON_DAYS = 90
/** Pseudo income id: set aside on the 1st of each month rather than on a payday. */
export const MONTHLY = "MONTHLY"
/** Pseudo income id: set aside every 14 days, lined up with the first payday when there is one. */
export const FORTNIGHTLY = "FORTNIGHTLY"

/** How often you'd like to move money into pots. */
export const FREQUENCIES = ["payday", "fortnightly", "monthly"] as const
export type Frequency = (typeof FREQUENCIES)[number]
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  payday: "Every payday",
  fortnightly: "Every fortnight",
  monthly: "Once a month",
}

export type PlanAccount = {
  id: number
  name: string
  type: string
  balance: number
}

/** A recurring payment in or out, projected on the basis you chose on the budget page. */
export type PlanFlow = {
  /** short id the model refers to: I1, I2… for income, B1, B2… for bills */
  id: string
  name: string
  category: string
  accountId: number
  cadence: Cadence
  /** per occurrence */
  amount: number
  monthly: number
  /** first occurrence on or after the snapshot start */
  nextDate: string
}

/** A one-off expense you told the app about, e.g. a car service. */
export type PlanOneOff = {
  /** short id the model refers to: U1, U2… */
  id: string
  name: string
  date: string
  amount: number
  /** null when you haven't said which account pays it */
  accountId: number | null
}

/** Money in or out that isn't on a schedule, per category and account. */
export type PlanIrregular = {
  category: string
  accountId: number
  monthly: number
}

export type PlanSnapshot = {
  /** first day of the projection */
  start: string
  /** last day with transactions; balances are as of then */
  dataEnd: string
  currency: string
  accounts: PlanAccount[]
  incomes: PlanFlow[]
  bills: PlanFlow[]
  /** day-to-day spending */
  variable: PlanIrregular[]
  /** income that isn't on a schedule */
  otherIncome: PlanIrregular[]
  budgets: { category: string; budget: number | null; projected: number }[]
  /** one-off expenses you expect; missing on plans made before they existed */
  upcoming?: PlanOneOff[]
}

// ── The plan the model returns ───────────────────────────────────────────────

export const PRIORITIES = ["high", "medium", "low"] as const

export const PlanSchema = z.object({
  summary: z
    .string()
    .describe("One sentence, at most 25 words: the idea of the plan"),
  set_asides: z
    .array(
      z.object({
        pot: z
          .string()
          .describe(
            "Short pot name, one or two words, e.g. 'Housing' or 'Annual bills'"
          ),
        income_id: z
          .string()
          .describe(
            `The income whose payday triggers this, e.g. "I1", "${FORTNIGHTLY}" for every 14 days, or "${MONTHLY}" for the 1st of each month`
          ),
        from_account_id: z
          .number()
          .int()
          .describe("Account the money is taken from"),
        to_account_id: z
          .number()
          .int()
          .nullable()
          .describe(
            "Account the money moves to, or null to earmark it in the from account"
          ),
        amount: z.number().describe("Amount each time the income arrives"),
        covers: z
          .array(z.string())
          .describe("Bill ids this pot pays, e.g. ['B1', 'B4']"),
        note: z.string().describe("At most 12 words: why this amount"),
      })
    )
    .describe(
      "Money to move or earmark each payday; several entries may fund one pot"
    ),
  focus: z
    .array(
      z.object({
        title: z.string().describe("At most 6 words"),
        detail: z
          .string()
          .describe("One sentence, at most 20 words, with the key number"),
        priority: z.enum(PRIORITIES),
        monthly_impact: z
          .number()
          .nullable()
          .describe(
            "Estimated monthly saving or gain, or null when not quantifiable"
          ),
      })
    )
    .describe(
      "Three to six things to focus on, most important first; never empty"
    ),
  warnings: z
    .array(z.string())
    .describe(
      "Risks or data problems, each one sentence of at most 15 words; at most four"
    ),
})
export type Plan = z.infer<typeof PlanSchema>

export const PlannerTurnSchema = z.object({
  reply: z.string().describe("Your message to the person: plain text, short"),
  plan: PlanSchema.nullable().describe(
    "The full revised plan, or null if it is unchanged"
  ),
})
export type PlannerTurn = z.infer<typeof PlannerTurnSchema>

/** Drop set-asides that point at ids the snapshot doesn't have, noting what was dropped. */
export function sanitizePlan(plan: Plan, snap: PlanSnapshot): Plan {
  const incomeIds = new Set([
    MONTHLY,
    FORTNIGHTLY,
    ...snap.incomes.map((i) => i.id),
  ])
  const accountIds = new Set(snap.accounts.map((a) => a.id))
  const billIds = new Set(snap.bills.map((b) => b.id))
  const dropped: string[] = []
  const setAsides = plan.set_asides.flatMap((s) => {
    const valid =
      incomeIds.has(s.income_id) &&
      accountIds.has(s.from_account_id) &&
      (s.to_account_id === null || accountIds.has(s.to_account_id)) &&
      s.amount > 0
    if (!valid) {
      dropped.push(s.pot)
      return []
    }
    return [
      {
        ...s,
        to_account_id:
          s.to_account_id === s.from_account_id ? null : s.to_account_id,
        amount: Math.round(s.amount * 100) / 100,
        covers: s.covers.filter((c) => billIds.has(c)),
      },
    ]
  })
  return {
    ...plan,
    set_asides: setAsides,
    warnings: dropped.length
      ? [
          ...plan.warnings,
          `Ignored set-asides with unknown accounts or income: ${dropped.join(", ")}`,
        ]
      : plan.warnings,
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

const toIso = (d: Date) => format(d, "yyyy-MM-dd")
const round2 = (n: number) => Math.round(n * 100) / 100

/** The nth occurrence after `anchor`, keeping the day of month for monthly cadences. */
function occurrence(anchor: string, cadence: Cadence, n: number) {
  const d = parseISO(anchor)
  switch (cadence) {
    case "weekly":
      return toIso(addDays(d, 7 * n))
    case "fortnightly":
      return toIso(addDays(d, 14 * n))
    case "monthly":
      return toIso(addMonths(d, n))
    case "quarterly":
      return toIso(addMonths(d, 3 * n))
    case "yearly":
      return toIso(addMonths(d, 12 * n))
  }
}

/** Every occurrence of a flow in [from, to]. */
function occurrencesBetween(
  anchor: string,
  cadence: Cadence,
  from: string,
  to: string
) {
  const out: string[] = []
  // start a little before `from` so nothing is skipped, then filter
  const gap = CADENCE_DAYS[cadence].days
  let n = Math.max(
    0,
    Math.floor(
      differenceInCalendarDays(parseISO(from), parseISO(anchor)) / gap
    ) - 1
  )
  for (; ; n++) {
    const date = occurrence(anchor, cadence, n)
    if (date > to) return out
    if (date >= from) out.push(date)
  }
}

export function buildSnapshot({
  lines,
  series,
  txs,
  overrides,
  accounts,
  categoryName,
  dataEnd,
  today,
  currency,
  budgets,
  upcoming = [],
}: {
  lines: BudgetLine[]
  series: RecurringSeries[]
  txs: RecurringTx[]
  overrides: Map<string, RecurringOverride>
  accounts: PlanAccount[]
  categoryName: (line: Pick<BudgetLine, "categoryId" | "direction">) => string
  dataEnd: string
  today: string
  currency: string
  budgets: Map<number, number | null>
  upcoming?: Omit<PlanOneOff, "id">[]
}): PlanSnapshot {
  const startDate = addDays(parseISO(dataEnd), 1)
  const start = today > toIso(startDate) ? today : toIso(startDate)
  const horizonEnd = toIso(addDays(parseISO(start), 400))

  const flows = (direction: 1 | -1, prefix: string) =>
    lines
      .filter((l) => l.direction === direction)
      .flatMap((l) =>
        l.series
          .filter((s) => s.monthly > 0)
          .map((s) => ({ s, category: categoryName(l) }))
      )
      .sort((a, b) => b.s.monthly - a.s.monthly)
      .map(({ s, category }, i): PlanFlow => {
        const next =
          occurrencesBetween(s.lastDate, s.cadence, start, horizonEnd)[0] ??
          s.nextDate
        return {
          id: `${prefix}${i + 1}`,
          name: s.note ? `${s.example} (${s.note})` : s.example,
          category,
          accountId: s.accountId,
          cadence: s.cadence,
          amount: round2(
            (s.monthly * CADENCE_DAYS[s.cadence].days) / DAYS_PER_MONTH
          ),
          monthly: s.monthly,
          nextDate: next,
        }
      })

  // Split each category's unscheduled money across accounts by where it actually went.
  const scheduled = new Set(
    series.filter((s) => !overrides.get(s.key)?.excluded).map((s) => s.key)
  )
  const otherByLine = new Map<string, Map<number, number>>()
  for (const tx of txs) {
    const key = seriesKeyOf(tx)
    if (key && scheduled.has(key)) continue
    // same direction rule as the budget lines, so refunds net off their category
    const direction =
      tx.categoryKind === "income"
        ? 1
        : tx.categoryKind === "expense"
          ? -1
          : Math.sign(tx.amount) || 1
    const line = `${tx.categoryId ?? "none"}:${direction > 0 ? "in" : "out"}`
    const m = otherByLine.get(line) ?? new Map<number, number>()
    m.set(tx.accountId, (m.get(tx.accountId) ?? 0) + tx.amount * direction)
    otherByLine.set(line, m)
  }
  const irregular = (direction: 1 | -1) =>
    lines
      .filter((l) => l.direction === direction && l.other.monthly > 0)
      .flatMap((l) => {
        const byAccount = [...(otherByLine.get(l.key) ?? [])].filter(
          ([, x]) => x > 0
        )
        const total = byAccount.reduce((s, [, x]) => s + x, 0)
        if (total === 0) return []
        return byAccount.map(([accountId, amount]) => ({
          category: categoryName(l),
          accountId,
          monthly: round2((l.other.monthly * amount) / total),
        }))
      })
      .filter((x) => x.monthly >= 1)
      .sort((a, b) => b.monthly - a.monthly)

  return {
    start,
    dataEnd,
    currency,
    accounts,
    incomes: flows(1, "I"),
    bills: flows(-1, "B"),
    variable: irregular(-1),
    otherIncome: irregular(1),
    budgets: lines
      .filter((l) => l.direction < 0)
      .map((l) => ({
        category: categoryName(l),
        budget:
          l.categoryId !== null ? (budgets.get(l.categoryId) ?? null) : null,
        projected: l.projected,
      })),
    upcoming: upcoming
      .filter((u) => u.date >= start)
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map((u, i) => ({ ...u, id: `U${i + 1}` })),
  }
}

// ── Simulation ───────────────────────────────────────────────────────────────

/** Accounts whose balance can't go below zero without trouble. */
export const isCashAccount = (type: string) =>
  !["credit_card", "loan"].includes(type)

export type PotSummary = {
  name: string
  /** where the money sits */
  accountId: number
  /** set aside per month on average */
  monthlyIn: number
  /** bills it covers, per month */
  monthlyOut: number
  /** starting balance needed so it never runs dry over the horizon */
  seed: number
  covers: string[]
}

export type ScheduledEvent = {
  date: string
  kind: "income" | "bill" | "set-aside"
  name: string
  amount: number
  accountId: number
  /** for set-asides: the account the money comes from */
  fromAccountId?: number
  /** for bills: the pot that pays it; for set-asides: the pot it funds */
  pot: string | null
  /** a one-off expense you added, not a recurring bill */
  oneOff?: boolean
}

export type Simulation = {
  days: string[]
  /** end-of-day balance per account id */
  balances: Record<number, number[]>
  /** running balance per pot, seed included */
  pots: Record<string, number[]>
  potSummaries: PotSummary[]
  /** dated events, in order */
  events: ScheduledEvent[]
  /** cash accounts that dip below zero: first date and the lowest point */
  overdrafts: { accountId: number; date: string; lowest: number }[]
  /** bills no pot covers */
  uncovered: string[]
  monthly: {
    income: number
    bills: number
    variable: number
    setAside: number
    /** income left after set-asides, day-to-day spending and bills no pot covers */
    free: number
  }
}

const PER_MONTH: Record<Cadence, number> = {
  weekly: DAYS_PER_MONTH / 7,
  fortnightly: DAYS_PER_MONTH / 14,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
}

/**
 * Run the plan (or no plan) forward day by day: income lands, set-asides move money into
 * pots, bills draw from their account and from the pot covering them, and day-to-day
 * spending is spread evenly over each day.
 */
export function simulate(
  snap: PlanSnapshot,
  plan: Plan | null,
  days = HORIZON_DAYS
): Simulation {
  const end = toIso(addDays(parseISO(snap.start), days - 1))
  const setAsides = plan?.set_asides ?? []
  const billPot = new Map<string, string>()
  for (const s of setAsides)
    for (const b of s.covers) if (!billPot.has(b)) billPot.set(b, s.pot)

  const events: ScheduledEvent[] = []
  const setAsideOn = (date: string, incomeId: string) => {
    for (const s of setAsides.filter((x) => x.income_id === incomeId)) {
      events.push({
        date,
        kind: "set-aside",
        name: s.pot,
        amount: s.amount,
        accountId: s.to_account_id ?? s.from_account_id,
        fromAccountId: s.from_account_id,
        pot: s.pot,
      })
    }
  }
  for (const inc of snap.incomes) {
    for (const date of occurrencesBetween(
      inc.nextDate,
      inc.cadence,
      snap.start,
      end
    )) {
      events.push({
        date,
        kind: "income",
        name: inc.name,
        amount: inc.amount,
        accountId: inc.accountId,
        pot: null,
      })
      setAsideOn(date, inc.id)
    }
  }
  for (let d = parseISO(snap.start); toIso(d) <= end; d = addDays(d, 1)) {
    if (d.getDate() === 1) setAsideOn(toIso(d), MONTHLY)
  }
  for (const date of occurrencesBetween(
    fortnightAnchor(snap),
    "fortnightly",
    snap.start,
    end
  )) {
    setAsideOn(date, FORTNIGHTLY)
  }
  for (const bill of snap.bills) {
    for (const date of occurrencesBetween(
      bill.nextDate,
      bill.cadence,
      snap.start,
      end
    )) {
      events.push({
        date,
        kind: "bill",
        name: bill.name,
        amount: bill.amount,
        accountId: bill.accountId,
        pot: billPot.get(bill.id) ?? null,
      })
    }
  }
  // one-offs without an account come out of the cash account with the most money
  const fallbackAccount = snap.accounts
    .filter((a) => isCashAccount(a.type))
    .toSorted((a, b) => b.balance - a.balance)[0]?.id
  for (const u of snap.upcoming ?? []) {
    const accountId = u.accountId ?? fallbackAccount
    if (accountId === undefined || u.date < snap.start || u.date > end) continue
    events.push({
      date: u.date,
      kind: "bill",
      name: u.name,
      amount: u.amount,
      accountId,
      pot: null,
      oneOff: true,
    })
  }
  // income first, then set-asides, then bills on the same day
  const order = { income: 0, "set-aside": 1, bill: 2 }
  events.sort(
    (a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]
  )

  const balance = new Map(snap.accounts.map((a) => [a.id, a.balance]))
  const daily = new Map<number, number>()
  for (const v of snap.variable)
    daily.set(
      v.accountId,
      (daily.get(v.accountId) ?? 0) - v.monthly / DAYS_PER_MONTH
    )
  for (const v of snap.otherIncome)
    daily.set(
      v.accountId,
      (daily.get(v.accountId) ?? 0) + v.monthly / DAYS_PER_MONTH
    )
  const potNames = [...new Set(setAsides.map((s) => s.pot))]
  const pot = new Map(potNames.map((p) => [p, 0]))
  const potMin = new Map(potNames.map((p) => [p, 0]))

  const dayList: string[] = []
  const balances: Record<number, number[]> = Object.fromEntries(
    snap.accounts.map((a) => [a.id, []])
  )
  const potRuns: Record<string, number[]> = Object.fromEntries(
    potNames.map((p) => [p, []])
  )
  let i = 0
  for (let d = parseISO(snap.start); toIso(d) <= end; d = addDays(d, 1)) {
    const date = toIso(d)
    for (; i < events.length && events[i].date === date; i++) {
      const e = events[i]
      if (e.kind === "income")
        balance.set(e.accountId, (balance.get(e.accountId) ?? 0) + e.amount)
      else if (e.kind === "set-aside") {
        const from = e.fromAccountId!
        balance.set(from, (balance.get(from) ?? 0) - e.amount)
        balance.set(e.accountId, (balance.get(e.accountId) ?? 0) + e.amount)
        pot.set(e.pot!, pot.get(e.pot!)! + e.amount)
      } else {
        balance.set(e.accountId, (balance.get(e.accountId) ?? 0) - e.amount)
        if (e.pot) {
          const left = pot.get(e.pot)! - e.amount
          pot.set(e.pot, left)
          potMin.set(e.pot, Math.min(potMin.get(e.pot)!, left))
        }
      }
    }
    for (const [id, delta] of daily)
      balance.set(id, (balance.get(id) ?? 0) + delta)
    dayList.push(date)
    for (const a of snap.accounts)
      balances[a.id].push(round2(balance.get(a.id) ?? 0))
    for (const p of potNames) potRuns[p].push(pot.get(p)!)
  }

  const potSummaries = potNames.map((name): PotSummary => {
    const entries = setAsides.filter((s) => s.pot === name)
    const covers = [...new Set(entries.flatMap((s) => s.covers))].filter(
      (b) => billPot.get(b) === name
    )
    const seed = round2(-potMin.get(name)!)
    potRuns[name] = potRuns[name].map((v) => round2(v + seed))
    return {
      name,
      accountId: entries[0].to_account_id ?? entries[0].from_account_id,
      monthlyIn: round2(
        entries.reduce(
          (s, x) => s + x.amount * timesPerMonth(snap, x.income_id),
          0
        )
      ),
      monthlyOut: round2(
        covers.reduce(
          (s, b) => s + (snap.bills.find((x) => x.id === b)?.monthly ?? 0),
          0
        )
      ),
      seed,
      covers,
    }
  })

  const overdrafts = snap.accounts
    .filter((a) => isCashAccount(a.type))
    .flatMap((a) => {
      const run = balances[a.id]
      const first = run.findIndex((v) => v < 0)
      return first < 0
        ? []
        : [{ accountId: a.id, date: dayList[first], lowest: Math.min(...run) }]
    })

  const sum = (xs: { monthly: number }[]) =>
    xs.reduce((s, x) => s + x.monthly, 0)
  const income = sum(snap.incomes) + sum(snap.otherIncome)
  const uncovered = snap.bills.filter((b) => !billPot.has(b.id))
  const setAside = potSummaries.reduce((s, p) => s + p.monthlyIn, 0)
  const variable = sum(snap.variable)

  return {
    days: dayList,
    balances,
    pots: potRuns,
    potSummaries,
    events,
    overdrafts,
    uncovered: uncovered.map((b) => b.id),
    monthly: {
      income: round2(income),
      bills: round2(sum(snap.bills)),
      variable: round2(variable),
      setAside: round2(setAside),
      free: round2(income - setAside - variable - sum(uncovered)),
    },
  }
}

/** Where the fortnightly schedule starts: a fortnightly payday, else the first payday, else day one. */
function fortnightAnchor(snap: PlanSnapshot) {
  const pays = snap.incomes.toSorted((a, b) =>
    a.nextDate.localeCompare(b.nextDate)
  )
  const payday =
    (pays.find((i) => i.cadence === "fortnightly") ?? pays[0])?.nextDate ??
    snap.start
  // step back to the first one on or after the start, so none are skipped before the payday
  const back = Math.floor(
    differenceInCalendarDays(parseISO(payday), parseISO(snap.start)) / 14
  )
  return toIso(addDays(parseISO(payday), -14 * back))
}

/** How many times a month an income (or the monthly pseudo-income) arrives. */
export function timesPerMonth(snap: PlanSnapshot, incomeId: string) {
  if (incomeId === MONTHLY) return 1
  if (incomeId === FORTNIGHTLY) return PER_MONTH.fortnightly
  const inc = snap.incomes.find((i) => i.id === incomeId)
  return inc ? PER_MONTH[inc.cadence] : 0
}

/** A short text summary of a simulation, for the model to check its plan against. */
export function describeSimulation(snap: PlanSnapshot, sim: Simulation) {
  const name = (id: number) =>
    snap.accounts.find((a) => a.id === id)?.name ?? `#${id}`
  const lines = [
    `Simulated ${HORIZON_DAYS} days from ${snap.start}.`,
    `Monthly: income ${sim.monthly.income}, set aside ${sim.monthly.setAside}, day-to-day spending ${sim.monthly.variable}, left over ${sim.monthly.free}.`,
    ...sim.potSummaries.map(
      (p) =>
        `Pot "${p.name}" in ${name(p.accountId)}: in ${p.monthlyIn}/mo, bills ${p.monthlyOut}/mo, starting balance needed ${p.seed}, covers ${p.covers.join(", ") || "nothing"}.`
    ),
    sim.uncovered.length
      ? `Bills no pot covers: ${sim.uncovered.join(", ")}.`
      : "Every bill is covered by a pot.",
    ...(snap.upcoming ?? []).map(
      (u) =>
        `One-off ${u.id} "${u.name}" of ${u.amount} on ${u.date}${u.accountId ? ` from ${name(u.accountId)}` : ""}.`
    ),
    ...sim.overdrafts.map(
      (o) =>
        `${name(o.accountId)} goes below zero on ${o.date}, lowest ${o.lowest}.`
    ),
  ]
  return lines.join("\n")
}

/**
 * The lowest point of everything you hold except loans, combined. Transfers between your own
 * accounts aren't projected, so a single account can look like it drains while the money
 * that tops it up sits elsewhere; the combined balance doesn't have that problem.
 */
export function combinedLow(snap: PlanSnapshot, sim: Simulation) {
  const ids = snap.accounts.filter((a) => a.type !== "loan").map((a) => a.id)
  if (ids.length === 0 || sim.days.length === 0) return null
  const totals = sim.days.map((_, i) =>
    ids.reduce((s, id) => s + (sim.balances[id]?.[i] ?? 0), 0)
  )
  const i = totals.reduce((m, v, j) => (v < totals[m] ? j : m), 0)
  return { date: sim.days[i], balance: round2(totals[i]) }
}
