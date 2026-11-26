// "Can I buy this?" worked out from the numbers: what a purchase does to this pay cycle and
// the next few, to each savings goal and buffer, and which bills it would leave uncovered;
// the options for paying for it, each with its knock-on effects; and a verdict. Pure and
// read-only: commit_purchase works it out again from the same request and applies the
// option chosen.

import type { CardPosition } from "@/lib/planning/card"
import type { CyclePosition } from "@/lib/planning/cycle"
import { addDays, daysBetween } from "@/lib/planning/recurring-payments"

const round2 = (n: number) => Math.round(n * 100) / 100 + 0
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

export type WhatIfRequest = {
  memberId: string
  amount: number
  /** when they'd buy it, yyyy-MM-dd */
  date: string
  /** the account it would come from: their pay account when null; a card account puts it on the card */
  accountId: number | null
  description: string
  /** pays to spread it over, for the spread option; 2 and 3 are weighed when null */
  spreadOver: number | null
}

/** A what-if's id carries its request, so nothing is saved until commit_purchase. */
export function whatIfId(r: WhatIfRequest) {
  return `wi_${Buffer.from(JSON.stringify(r)).toString("base64url")}`
}

export function parseWhatIfId(id: string): WhatIfRequest {
  if (!id.startsWith("wi_")) throw new Error("That isn't a what_if id")
  try {
    const r = JSON.parse(Buffer.from(id.slice(3), "base64url").toString()) as WhatIfRequest
    if (typeof r.memberId !== "string" || !(r.amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error()
    return r
  } catch {
    throw new Error("That what_if id couldn't be read; run what_if again")
  }
}

/** A savings goal, one-off or buffer the plan puts money towards. */
export type Goal = {
  ref: string
  kind: "one_off" | "plan_item"
  name: string
  purpose: string
  planItemId: number | null
  oneOffId: number | null
  accountId: number | null
  account: string | null
  /** where this pay's move towards it leaves from */
  fromAccountId: number | null
  target: number | null
  saved: number
  /** what the plan puts in each week, on average */
  ratePerWeek: number
  /** a fixed finish date (a one-off's), else null */
  finishDate: string | null
  /** of this pay's move towards it from their accounts, what's still to go (so could be held back) */
  leftThisPay: number
  /** the move's amount this pay, as planned */
  plannedThisPay: number
  /** paid from a joint account or towards a shared cost */
  shared: boolean
}

export type BufferPot = {
  accountId: number
  name: string
  balance: number
  ratePerWeek: number
  /** one of the member's own accounts, so a short-term line can move from it */
  theirs: boolean
}

/** A typical pay cycle ahead, from the pays, the plan's moves and the bills on their cadence. */
export type CycleModel = {
  days: number
  income: number
  moves: number
  bills: number
  /** what they typically spend from their accounts in a cycle, from the last three */
  spending: number
}

export type ShortTermChange = {
  planItemId: number | null
  title: string
  fromAccountId: number
  toAccountId: number | null
  amount: number
  reason: string
}

export type PlanChange = {
  title: string
  purpose: "one_off" | "savings" | "buffer" | "debt" | "bills"
  fromAccountId: number | null
  toAccountId: number | null
  amount: number
  every: "week" | "fortnight" | "month"
  startDate: string
  endDate: string | null
  notes: string
}

export type OptionId = "pay_now" | "card" | "wait_until_next_pay" | `spread_over_${number}` | "use_buffer" | "pause_goal"

export type WhatIfOption = {
  id: OptionId
  label: string
  feasible: boolean
  /** feasible with room left for their usual spending until payday */
  comfortable: boolean
  /** the date it's paid (or the first part) */
  payDate: string
  /** what has to change, in words */
  changes: string[]
  /** to this pay's short-term allocation (applied straight away on commit) */
  shortTerm: ShortTermChange[]
  /** to the long-term plan (a pending change on commit, for a member to approve) */
  plan: PlanChange[]
  /** what's left in the pay account after bills and planned moves, this cycle, after it */
  thisCycleLeft: number
  /** what's left in each of the next cycles after bills, moves and usual spending, after it */
  nextCyclesLeft: number[]
  goalDelays: { goal: string; weeks: number }[]
  /** a card balance carried past its usual payment */
  carriesCardBalance: boolean
  uncovered: string[]
  notes: string[]
}

export type Verdict = "affordable" | "affordable_with_changes" | "not_affordable"

export type WhatIfResult = {
  whatIfId: string
  request: WhatIfRequest
  verdict: Verdict
  /** the verdict in a sentence, with the deciding number */
  headline: string
  recommended: OptionId | null
  /** the changes the recommended option needs */
  changes: string[]
  thisCycle: {
    start: string
    nextPayday: string
    daysLeft: number
    payAccount: string | null
    /** before the purchase: left after the bills and planned moves still to come */
    leftAfterBillsAndMoves: number
    /** their usual spending between now and payday */
    usualSpendingToPayday: number
    afterPurchase: number
    afterPurchaseAndUsualSpending: number
    /** bills or moves the purchase would leave uncovered if paid now */
    uncoveredIfPaidNow: { title: string; date: string; short: number }[]
  }
  nextCycles: { start: string; end: string; left: number; leftIfSpread: number | null; leftIfWait: number | null }[]
  goals: {
    name: string
    purpose: string
    account: string | null
    target: number | null
    saved: number
    ratePerWeek: number
    expectedFinish: string | null
    delayWeeks: Partial<Record<OptionId, number>>
    expectedFinishIfPaused: string | null
  }[]
  options: WhatIfOption[]
}

const weeksToSave = (amount: number, perWeek: number) => (perWeek > 0 ? Math.ceil((amount / perWeek) * 10) / 10 : null)

function finishOf(g: Goal, today: string, extraWeeks = 0) {
  if (g.finishDate) return g.finishDate
  if (g.target === null || g.ratePerWeek <= 0) return null
  const weeks = Math.max(0, (g.target - g.saved) / g.ratePerWeek) + extraWeeks
  return addDays(today, Math.ceil(weeks * 7))
}

/**
 * Work out a purchase against a member's position. `cycleEnd` and `cycleDays` give the next
 * cycles' dates; `future` what a typical one leaves.
 */
export function whatIf(input: {
  today: string
  request: WhatIfRequest
  position: CyclePosition
  future: CycleModel
  /** how often the pay comes, for the next cycles' dates and a spread plan item */
  payEvery: "week" | "fortnight" | "month"
  /** balances by account, and their names */
  balances: Map<number, number>
  accountName: Map<number, string>
  mine: Set<number>
  goals: Goal[]
  buffers: BufferPot[]
  card: CardPosition | null
  /** where a spread purchase's money would gather; the pay account when null */
  oneOffAccountId: number | null
}): WhatIfResult {
  const { today, request: r, position: pos, future } = input
  const A = round2(r.amount)
  const payAccount = pos.payAccount
  const cycleEnd = pos.cycle.end > today ? pos.cycle.end : addDays(today, 1)
  const daysLeft = Math.max(0, daysBetween(today, cycleEnd))
  const perDay = future.days > 0 ? future.spending / future.days : 0
  const usualToPayday = round2(perDay * daysLeft)
  const isCard = r.accountId !== null && input.card?.accountId === r.accountId
  const fromPayAccount = r.accountId === null || r.accountId === payAccount?.id || isCard

  // what's free this cycle before the purchase, in the account it comes from
  const base = round2(
    fromPayAccount
      ? (pos.leftInPayAccount ?? 0)
      : (input.balances.get(r.accountId!) ?? 0) -
          sum(pos.billsDue.filter((b) => b.fromAccountId === r.accountId).map((b) => b.amount))
  )
  const cycleLeft = round2(future.income - future.moves - future.bills - future.spending)
  const step = input.payEvery === "week" ? 7 : input.payEvery === "fortnight" ? 14 : null
  const cycleStart = (k: number) =>
    step ? addDays(cycleEnd, step * k) : monthAfter(cycleEnd, k)
  const next = [0, 1, 2].map((k) => ({ start: cycleStart(k), end: cycleStart(k + 1) }))
  const laterThisCycle = r.date >= cycleEnd

  const options: WhatIfOption[] = []

  // which bills paying now would leave uncovered, running the pay account forward
  const uncoveredIfPaid = (amount: number) => {
    const out: { title: string; date: string; short: number }[] = []
    let running = (payAccount?.balance ?? 0) - amount
    const events = [
      ...pos.paysDue.filter((p) => p.accountId === payAccount?.id).map((p) => ({ date: p.date, title: p.name, amount: p.amount })),
      ...pos.moves.filter((m) => m.left > 0 && m.fromAccountId === payAccount?.id).map((m) => ({ date: today, title: m.title, amount: -m.left })),
      ...pos.billsDue.filter((b) => b.fromAccountId === payAccount?.id).map((b) => ({ date: b.date, title: b.name, amount: -b.amount })),
    ].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
    for (const e of events) {
      running = round2(running + e.amount)
      if (e.amount < 0 && running < 0) {
        const short = round2(Math.min(-e.amount, -running))
        out.push({ title: e.title, date: e.date, short })
      }
    }
    return out
  }

  // ── pay now ──
  if (!laterThisCycle) {
    const after = round2(base - A)
    const cushion = round2(after - usualToPayday)
    const uncovered = fromPayAccount && !isCard ? uncoveredIfPaid(A) : []
    options.push({
      id: "pay_now",
      label: `Pay ${r.description} now from ${isCard ? "the pay account" : (input.accountName.get(r.accountId ?? payAccount?.id ?? -1) ?? "the pay account")}`,
      feasible: after >= 0 && uncovered.length === 0,
      comfortable: cushion >= 0,
      payDate: r.date,
      changes:
        after >= 0 && cushion < 0
          ? [`Spend about ${(-cushion).toFixed(2)} less than usual before payday (${cycleEnd})`]
          : [],
      shortTerm: [],
      plan: [],
      thisCycleLeft: after,
      nextCyclesLeft: next.map(() => cycleLeft),
      goalDelays: [],
      carriesCardBalance: false,
      uncovered: uncovered.map((u) => `${u.title} on ${u.date}, short ${u.short.toFixed(2)}`),
      notes: [],
    })
  }

  // ── on the card ──
  if (input.card && !laterThisCycle) {
    const due = input.card.nextPaymentExpected
    const dueThisCycle = due !== null && due < cycleEnd
    const left = dueThisCycle ? round2(base - A) : round2(cycleLeft - A)
    options.push({
      id: "card",
      label: `Put it on ${input.card.name} and pay it off with the ${due ? `card payment around ${due}` : "next card payment"}`,
      feasible: left >= 0,
      comfortable: dueThisCycle ? left - usualToPayday >= 0 : left >= 0,
      payDate: r.date,
      changes: [`Pay ${A.toFixed(2)} more than usual into ${input.card.name} with its ${due ?? "next"} payment`],
      shortTerm: [],
      plan: [],
      thisCycleLeft: dueThisCycle ? left : base,
      nextCyclesLeft: next.map((_, k) => (k === 0 && !dueThisCycle ? left : cycleLeft)),
      goalDelays: [],
      carriesCardBalance: left < 0,
      uncovered: [],
      notes: [
        due === null
          ? "No regular card payment was found, so when it's due is a guess."
          : "Akahu doesn't give the card's due date; the date is when it's usually paid.",
      ],
    })
  }

  // ── wait for the next pay ──
  {
    const payDate = laterThisCycle ? r.date : cycleEnd
    const left = round2(cycleLeft - A)
    options.push({
      id: "wait_until_next_pay",
      label: laterThisCycle ? `Buy it on ${r.date}, in a later pay cycle` : `Wait until the next pay (${cycleEnd})`,
      feasible: left >= 0,
      comfortable: left >= 0,
      payDate,
      changes: laterThisCycle ? [] : [`Buy it on or after ${cycleEnd}, once the next pay lands`],
      shortTerm: [],
      plan: [],
      thisCycleLeft: base,
      nextCyclesLeft: next.map((_, k) => (k === 0 ? left : cycleLeft)),
      goalDelays: [],
      carriesCardBalance: false,
      uncovered: [],
      notes: future.income <= 0 ? ["No regular pay is expected next cycle, so this leans on savings."] : [],
    })
  }

  // ── spread over several pays: put aside part of it each pay, then pay it ──
  for (const n of r.spreadOver ? [Math.max(2, Math.round(r.spreadOver))] : [2, 3]) {
    const per = round2(A / n)
    const thisLeft = laterThisCycle ? base : round2(base - per)
    const later = next.map((_, k) => (k < n - (laterThisCycle ? 0 : 1) ? round2(cycleLeft - per) : cycleLeft))
    const lastPart = laterThisCycle ? cycleStart(n - 1) : cycleStart(n - 2)
    const to = input.oneOffAccountId ?? payAccount?.id ?? null
    options.push({
      id: `spread_over_${n}`,
      label: `Put aside ${per.toFixed(2)} from each of ${n} pays, then buy it by ${lastPart}`,
      feasible: thisLeft >= 0 && later.every((x) => x >= 0),
      comfortable: thisLeft - (laterThisCycle ? 0 : usualToPayday) >= 0 && later.every((x) => x >= 0),
      payDate: lastPart,
      changes: [`Add ${per.toFixed(2)} a pay towards ${r.description} for ${n} pays, ending ${lastPart} (a plan change to approve)`],
      shortTerm: [],
      plan: [
        {
          title: r.description.slice(0, 50),
          purpose: "one_off",
          fromAccountId: payAccount?.id ?? null,
          toAccountId: to === payAccount?.id ? null : to,
          amount: per,
          every: input.payEvery,
          startDate: laterThisCycle ? cycleEnd : pos.cycle.start,
          endDate: lastPart,
          notes: `Saving up for ${r.description} (${A.toFixed(2)}) over ${n} pays`,
        },
      ],
      thisCycleLeft: thisLeft,
      nextCyclesLeft: later,
      goalDelays: [],
      carriesCardBalance: false,
      uncovered: [],
      notes: [],
    })
  }

  // ── use a buffer ──
  for (const b of input.buffers) {
    if (b.balance <= 0) continue
    const take = round2(Math.min(A, b.balance))
    const covered = take >= A
    const after = round2(base - (A - take))
    const weeks = weeksToSave(take, b.ratePerWeek)
    options.push({
      id: "use_buffer",
      label: `Take ${take.toFixed(2)} from ${b.name} (buffer, ${b.balance.toFixed(2)} in it)`,
      feasible: covered || after >= 0,
      comfortable: covered || after - usualToPayday >= 0,
      payDate: r.date,
      changes: [
        `Move ${take.toFixed(2)} from ${b.name} into ${payAccount?.name ?? "the pay account"}`,
        ...(covered ? [] : [`and ${(A - take).toFixed(2)} from this pay`]),
      ],
      shortTerm:
        b.theirs && payAccount && b.accountId !== payAccount.id
          ? [{ planItemId: null, title: `From ${b.name}`.slice(0, 60), fromAccountId: b.accountId, toAccountId: payAccount.id, amount: take, reason: `Buffer towards ${r.description}` }]
          : [],
      plan: [],
      thisCycleLeft: after,
      nextCyclesLeft: next.map(() => cycleLeft),
      goalDelays: [{ goal: b.name, weeks: weeks ?? Number.POSITIVE_INFINITY }],
      carriesCardBalance: false,
      uncovered: [],
      notes: [
        ...(b.theirs ? [] : [`${b.name} isn't one of their own accounts, so the move is made by hand rather than as a short-term line.`]),
        weeks === null ? `Nothing in the plan tops ${b.name} up, so it stays lower until something does.` : `${b.name} takes about ${weeks} weeks to build back at the plan's rate.`,
      ],
    })
    break
  }

  // ── hold back a goal's move this pay ──
  if (!laterThisCycle) {
    const want = round2(A - base + usualToPayday)
    const candidates = input.goals
      // only a move out of the account it's paid from frees money there
      .filter((g) => g.planItemId !== null && g.leftThisPay > 0 && (g.fromAccountId ?? payAccount?.id) === payAccount?.id)
      // savings before debt, debt before buffers, one-offs (with their deadlines) last
      .sort((a, b) => rank(a.purpose) - rank(b.purpose) || b.leftThisPay - a.leftThisPay)
    const taken: { g: Goal; freed: number }[] = []
    let freed = 0
    for (const g of candidates) {
      if (freed >= Math.max(want, 0)) break
      const f = round2(Math.min(g.leftThisPay, Math.max(want, 0) - freed))
      if (f <= 0) continue
      taken.push({ g, freed: f })
      freed = round2(freed + f)
    }
    // worth offering whenever paying now leaves bills or usual spending short
    if (taken.length && want > 0) {
      const after = round2(base + freed - A)
      const delays = taken.map(({ g, freed: f }) => ({ goal: g.name, weeks: weeksToSave(f, g.ratePerWeek) ?? 0 }))
      options.push({
        id: "pause_goal",
        label: `Hold back ${taken.map(({ g, freed: f }) => `${f.toFixed(2)} of ${g.name}`).join(" and ")} this pay`,
        feasible: after >= 0,
        comfortable: after - usualToPayday >= 0,
        payDate: r.date,
        changes: taken.map(({ g, freed: f }) => `Move ${(g.plannedThisPay - f).toFixed(2)} instead of ${g.plannedThisPay.toFixed(2)} towards ${g.name} this pay`),
        shortTerm: taken
          .filter(({ g }) => (g.fromAccountId ?? payAccount?.id) != null)
          .map(({ g, freed: f }) => ({
            planItemId: g.planItemId,
            title: g.name.slice(0, 60),
            fromAccountId: (g.fromAccountId ?? payAccount?.id)!,
            toAccountId: g.accountId,
            amount: round2(g.plannedThisPay - f),
            reason: `Held back ${f.toFixed(2)} towards ${r.description}`,
          })),
        plan: [],
        thisCycleLeft: after,
        nextCyclesLeft: next.map(() => cycleLeft),
        goalDelays: delays,
        carriesCardBalance: false,
        uncovered: [],
        notes: taken.some(({ g }) => g.shared) ? ["One of these goals is shared: say so to the other member."] : [],
      })
    }
  }

  // ── the verdict ──
  const by = (id: string) => options.find((o) => o.id === id)
  const payNow = by("pay_now")
  const order = [
    "wait_until_next_pay",
    ...options.filter((o) => o.id.startsWith("spread_over_")).map((o) => o.id),
    "pause_goal",
    "card",
    "use_buffer",
  ]
  let verdict: Verdict
  let recommended: WhatIfOption | undefined
  if (laterThisCycle ? by("wait_until_next_pay")?.comfortable : payNow?.feasible && payNow.comfortable) {
    verdict = "affordable"
    recommended = laterThisCycle ? by("wait_until_next_pay") : payNow
  } else {
    recommended =
      order.map(by).find((o) => o?.feasible && o.comfortable) ??
      (payNow?.feasible ? payNow : undefined) ??
      order.map(by).find((o) => o?.feasible)
    verdict = recommended ? "affordable_with_changes" : "not_affordable"
  }

  const thisAfter = round2(base - (laterThisCycle ? 0 : A))
  const headline =
    verdict === "affordable"
      ? laterThisCycle
        ? `Yes: that cycle has about ${cycleLeft.toFixed(2)} spare after bills, moves and usual spending, ${round2(cycleLeft - A).toFixed(2)} after it.`
        : `Yes: ${base.toFixed(2)} is left in ${payAccount?.name ?? "the pay account"} after bills and planned moves; ${thisAfter.toFixed(2)} after it, and ${round2(thisAfter - usualToPayday).toFixed(2)} after usual spending to payday.`
      : verdict === "affordable_with_changes"
        ? `Yes if: ${recommended!.label.charAt(0).toLowerCase()}${recommended!.label.slice(1)}. Paying now leaves ${thisAfter.toFixed(2)} after bills and moves, ${round2(thisAfter - usualToPayday).toFixed(2)} after usual spending.`
        : `No: paying it now leaves ${thisAfter.toFixed(2)}, and no option covers it without leaving bills or usual spending short.`

  return {
    whatIfId: whatIfId(r),
    request: r,
    verdict,
    headline,
    recommended: recommended?.id ?? null,
    changes: recommended ? [...recommended.changes] : [],
    thisCycle: {
      start: pos.cycle.start,
      nextPayday: cycleEnd,
      daysLeft,
      payAccount: payAccount?.name ?? null,
      leftAfterBillsAndMoves: base,
      usualSpendingToPayday: usualToPayday,
      afterPurchase: thisAfter,
      afterPurchaseAndUsualSpending: round2(thisAfter - usualToPayday),
      uncoveredIfPaidNow: laterThisCycle || !fromPayAccount || isCard ? [] : uncoveredIfPaid(A),
    },
    nextCycles: next.map((c, k) => ({
      start: c.start,
      end: c.end,
      left: cycleLeft,
      leftIfSpread: options.find((o) => o.id.startsWith("spread_over_"))?.nextCyclesLeft[k] ?? null,
      leftIfWait: by("wait_until_next_pay")?.nextCyclesLeft[k] ?? null,
    })),
    goals: input.goals.map((g) => {
      const delayWeeks: Partial<Record<OptionId, number>> = {}
      for (const o of options) {
        const d = o.goalDelays.find((x) => x.goal === g.name)
        if (d) delayWeeks[o.id] = d.weeks
      }
      const paused = delayWeeks.pause_goal ?? 0
      return {
        name: g.name,
        purpose: g.purpose,
        account: g.account,
        target: g.target,
        saved: g.saved,
        ratePerWeek: g.ratePerWeek,
        expectedFinish: finishOf(g, today),
        delayWeeks,
        expectedFinishIfPaused: paused > 0 && !g.finishDate ? finishOf(g, today, paused) : null,
      }
    }),
    options,
  }
}

function rank(purpose: string) {
  return ({ savings: 0, goal: 1, debt: 2, buffer: 3, one_off: 4 } as Record<string, number>)[purpose] ?? 5
}

function monthAfter(iso: string, k: number) {
  const [y, m, d] = iso.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1 + k, d))
  return date.toISOString().slice(0, 10)
}
