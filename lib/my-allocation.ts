// The My view's allocation: what the plan does with your pay this pay cycle, and how it's
// going. Pure, so Home and the tests agree.
//
// - The cycle: from the day your main pay (the largest regular income into your accounts)
//   last landed to the day before the next one is due. It moves on by itself each payday.
//   Without a regular pay to go by, it's the calendar month.
// - Your pay: the pays into your accounts in the cycle, landed and still due.
// - Moves: each allocation leaving one of your accounts. On the cycle's own pay and cadence
//   it's its amount once, all of it due straight away. Otherwise its amount per pay times the
//   pays into its account in the cycle when it runs on that pay's cadence, else its share
//   of the cycle's days. By now, the share of that for the pays that have landed.
//   Done: the transfers from that account into the allocation's account in the cycle (both
//   sides paired), or, for one tied to a category, that category's spending from it.
// - Bills: allocations that sit in one of your accounts with a category, paid from there:
//   that category's spending from your accounts against the cycle's amount, which counts
//   the category's regular bills that fall due in the cycle.
// - Your spending: your pay less the moves and bills, against everything else spent from
//   your accounts so far. Transfers out the plan doesn't name show as other moves.
// - Cas's short-term allocation (lib/short-term.ts): this pay's transfers. A line tied to a
//   plan allocation sets its amount for this pay; one that isn't is a move of its own, done
//   by the transfers from its account into its account (or, for money leaving the household,
//   by its merchant). What neither takes is still an other move.

import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns"

import { elapsed, monthOf } from "@/lib/budget-tracking"
import type {
  Category,
  PlanEvery,
  PlanItem,
  PlanPurpose,
} from "@/lib/db/schema"
import type { ShortTermLine } from "@/lib/short-term"
import { merchantName } from "@/supabase/functions/_shared/cas-queue"
import { PAY_MIN } from "@/supabase/functions/_shared/nudges"
import { merchantKey } from "@/supabase/functions/_shared/rules"
import { pairTransfers } from "@/supabase/functions/_shared/transfers"

const round2 = (n: number) => Math.round(n * 100) / 100 + 0
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

const PER_MONTH: Record<Exclude<PlanEvery, "once">, number> = {
  week: 52 / 12,
  fortnight: 26 / 12,
  month: 1,
}
const EVERY_DAYS: Record<Exclude<PlanEvery, "once">, number> = {
  week: 7,
  fortnight: 14,
  month: 365.25 / 12,
}

/** A pay or bill a few days past due may yet land; past this it isn't counted on. */
const GRACE_DAYS = 7

const shift = (iso: string, days: number) =>
  format(addDays(parseISO(iso), Math.round(days)), "yyyy-MM-dd")
const daysFrom = (a: string, b: string) =>
  differenceInCalendarDays(parseISO(b), parseISO(a))

/** A few dollars short of the mark still counts as done. */
const slack = (n: number) => Math.max(5, n * 0.02)

export type PayEvery = Exclude<PlanEvery, "once">

/** A regular income, as the plan inputs list it. */
export type PaySource = {
  name: string
  accountId: number | null
  /** null when it isn't weekly, fortnightly or monthly */
  every: PayEvery | null
  amount: number
  monthly: number
  lastDate: string | null
  nextDate: string | null
}

/** A regular bill, as the plan inputs list it. */
export type BillSeries = {
  categoryId: number | null
  accountId: number | null
  /** days between payments */
  days: number
  amount: number
  monthly: number
  lastDate: string
  nextDate: string
}

export type PayCycle = {
  /** the payday that began it, or the month's first day */
  start: string
  /** the next payday, or the next month's first day; past while that pay is late */
  end: string
  days: number
  /** the pay it runs between; null when it's the calendar month */
  pay: {
    name: string
    accountId: number
    every: PayEvery
    amount: number
  } | null
}

/**
 * This pay cycle: from your main pay's last payday to its next. The calendar month when no
 * regular pay comes into your accounts, or the main one is well overdue.
 */
export function payCycle(input: {
  today: string
  mine: number[]
  sources: PaySource[]
}): PayCycle {
  const { today } = input
  const mine = new Set(input.mine)
  const main = input.sources
    .filter(
      (s) =>
        s.accountId !== null &&
        mine.has(s.accountId) &&
        s.every !== null &&
        s.amount >= PAY_MIN &&
        s.lastDate !== null &&
        s.nextDate !== null &&
        s.lastDate <= today &&
        daysFrom(s.nextDate, today) <= GRACE_DAYS
    )
    .sort((a, b) => b.monthly - a.monthly)[0]
  if (!main) {
    const month = monthOf(today)
    return { ...month, pay: null }
  }
  return {
    start: main.lastDate!,
    end: main.nextDate!,
    days: daysFrom(main.lastDate!, main.nextDate!),
    pay: {
      name: main.name,
      accountId: main.accountId!,
      every: main.every!,
      amount: main.amount,
    },
  }
}

/** Any transaction in the cycle, transfers included. */
export type MoveTx = {
  id: number
  accountId: number
  date: string
  description: string
  /** signed: negative is money out */
  amount: number
  categoryId: number | null
}

export type AllocationStatus = "done" | "on_track" | "behind" | "untracked" | "skipped"

export type TrackedAllocation = {
  id: number
  title: string
  purpose: PlanPurpose | null
  /** where it goes, by account name, when the plan says */
  to: string | null
  amount: number
  every: PayEvery
  /** what the plan has for it this cycle */
  planned: number
  /** what should have gone by now; for a bill, what has (bills go when they're due) */
  byNow: number
  /** what has gone in the cycle; null when there's no way to tell (no account or category to match) */
  done: number | null
  status: AllocationStatus
  /** Cas's word on it this pay, from the short-term allocation */
  note: string | null
  /** a move of Cas's for this pay that the plan doesn't name */
  extra: boolean
}

export type MyAllocation = {
  cycle: PayCycle & {
    /** the cycle's pay is due and hasn't landed yet */
    late: boolean
  }
  pay: {
    soFar: number
    stillDue: number
    total: number
    /** the cycle's next pay; in a month, the next pay still to land into your accounts */
    next: { date: string; amount: number } | null
  }
  moves: TrackedAllocation[]
  bills: TrackedAllocation[]
  /** the plan's moves and bills this cycle */
  planned: number
  /** of the tracked ones: what should have gone by now, and what has */
  byNow: number
  done: number
  /** transfers out of your accounts the plan doesn't name */
  otherMoves: { amount: number; parts: { name: string; amount: number }[] }
  /** your pay less the moves and bills, against the rest of your accounts' spending */
  spending: { allowance: number; spent: number; byNow: number; left: number }
}

export function myAllocation(input: {
  today: string
  cycle: PayCycle
  /** your accounts */
  mine: number[]
  allocations: Pick<
    PlanItem,
    | "id"
    | "title"
    | "purpose"
    | "amount"
    | "every"
    | "categoryId"
    | "accountId"
    | "fromAccountId"
  >[]
  /** the cycle's transactions in every account, from its start to today, transfers included */
  txs: MoveTx[]
  categories: Pick<Category, "id" | "kind">[]
  sources: PaySource[]
  bills: BillSeries[]
  /** how often each account's main pay comes */
  payEvery: Map<number, PayEvery>
  accountName: Map<number, string>
  /** Cas's transfers for this pay */
  shortTerm?: ShortTermLine[]
}): MyAllocation {
  const { today, txs, cycle } = input
  const lines = input.shortTerm ?? []
  const forPlan = new Map(
    lines.flatMap((l) => (l.planItemId === null ? [] : [[l.planItemId, l] as const]))
  )
  /** a line's amount, and what of it should have gone by now */
  const lineSchedule = (l: ShortTermLine) => ({
    planned: round2(l.amount),
    byNow: l.dueDate === null || l.dueDate <= today ? round2(l.amount) : 0,
  })
  // a late pay keeps the cycle open through today
  const through = cycle.end > today ? cycle.end : shift(today, 1)
  const share = elapsed(cycle, today)
  const mine = new Set(input.mine)
  const kind = new Map(input.categories.map((c) => [c.id, c.kind]))
  const inCycle = txs.filter((t) => t.date >= cycle.start && t.date < through)

  /** each regular payment's dates in the cycle still to come, a few days late included */
  const datesDue = (
    s: { lastDate: string | null; nextDate: string | null },
    days: number
  ) => {
    const out: string[] = []
    if (!s.nextDate) return out
    for (let d = s.nextDate; d < through; d = shift(d, days)) {
      if (d >= cycle.start && daysFrom(d, today) <= GRACE_DAYS) out.push(d)
    }
    return out
  }

  // pays: income of a pay's size into your accounts, and the regular ones still due
  const isPay = (t: MoveTx) =>
    t.categoryId !== null &&
    kind.get(t.categoryId) === "income" &&
    t.amount >= PAY_MIN
  const landed = inCycle.filter((t) => mine.has(t.accountId) && isPay(t))
  const main = cycle.pay
  const due = input.sources
    .filter(
      (s) =>
        s.accountId !== null &&
        mine.has(s.accountId) &&
        s.every !== null &&
        s.amount >= PAY_MIN &&
        // the cycle's own next pay begins the next cycle
        !(main && s.accountId === main.accountId && s.name === main.name)
    )
    .flatMap((s) =>
      datesDue(s, EVERY_DAYS[s.every!]).map((date) => ({
        accountId: s.accountId!,
        date,
        amount: s.amount,
      }))
    )
    .sort((a, b) => a.date.localeCompare(b.date))
  const paysInto = (accountId: number) => ({
    landed: landed.filter((t) => t.accountId === accountId).length,
    due: due.filter((p) => p.accountId === accountId).length,
  })

  /** how many of `every` fit in the cycle */
  const per = (every: PayEvery) =>
    !main
      ? PER_MONTH[every]
      : every === main.every
        ? 1
        : cycle.days / EVERY_DAYS[every]

  /** the cycle's amount and what's due by now, on the pays into `from` */
  const schedule = (amount: number, every: PayEvery, from: number | null) => {
    // on the pay that began the cycle: all of it, from payday
    if (main && from === main.accountId && every === main.every)
      return { planned: round2(amount), byNow: round2(amount) }
    const pays = from === null ? { landed: 0, due: 0 } : paysInto(from)
    const count = pays.landed + pays.due
    const onPay =
      from !== null && input.payEvery.get(from) === every && count > 0
    const cycleAmount = onPay ? amount * count : amount * per(every)
    const byNow =
      count > 0 ? (cycleAmount * pays.landed) / count : cycleAmount * share
    return { planned: round2(cycleAmount), byNow: round2(byNow) }
  }

  const spentIn = (categoryId: number, accounts: (id: number) => boolean) =>
    round2(
      -sum(
        inCycle
          .filter((t) => t.categoryId === categoryId && accounts(t.accountId))
          .map((t) => t.amount)
      )
    )

  // transfers between accounts, paired; each out side is matched to at most one allocation
  const pairs = pairTransfers(inCycle)
  const pool = new Map<string, { amount: number; outIds: number[] }>()
  for (const p of pairs) {
    if (!mine.has(p.fromAccountId)) continue
    const k = `${p.fromAccountId}>${p.toAccountId}`
    const e = pool.get(k) ?? { amount: 0, outIds: [] }
    e.amount += p.amount
    e.outIds.push(p.outId)
    pool.set(k, e)
  }
  const matched = new Set<number>()

  const status = (
    planned: number,
    byNow: number,
    done: number | null
  ): AllocationStatus =>
    done === null
      ? "untracked"
      : planned < 1 && done < 1
        ? "skipped"
        : done >= planned - slack(planned)
        ? "done"
        : done >= byNow - slack(byNow)
          ? "on_track"
          : "behind"

  const recurring = input.allocations.filter(
    (a): a is typeof a & { every: PayEvery } =>
      a.every !== null && a.every !== "once" && (a.amount ?? 0) > 0
  )

  const moves: TrackedAllocation[] = recurring
    .filter((a) => a.fromAccountId !== null && mine.has(a.fromAccountId))
    .map((a): TrackedAllocation => {
      const from = a.fromAccountId!
      const line = forPlan.get(a.id)
      const s = line ? lineSchedule(line) : schedule(a.amount!, a.every, from)
      let done: number | null = null
      if (a.categoryId !== null) {
        done = spentIn(a.categoryId, (id) => id === from)
      } else if (a.accountId !== null) {
        // allocations into the same account share what moved there, in plan order
        const e = pool.get(`${from}>${a.accountId}`)
        done = e ? round2(Math.min(e.amount, s.planned)) : 0
        if (e) {
          e.amount = Math.max(0, e.amount - done)
          e.outIds.forEach((id) => matched.add(id))
        }
      }
      return {
        id: a.id,
        title: a.title,
        purpose: a.purpose,
        to:
          a.accountId !== null
            ? (input.accountName.get(a.accountId) ?? null)
            : null,
        amount: a.amount!,
        every: a.every,
        ...s,
        done,
        status: status(s.planned, s.byNow, done),
        note: line?.reason ?? null,
        extra: false,
      }
    })
  const moveCategories = new Set(
    recurring
      .filter(
        (a) =>
          a.fromAccountId !== null &&
          mine.has(a.fromAccountId) &&
          a.categoryId !== null
      )
      .map((a) => a.categoryId!)
  )
  const billItems = recurring.filter(
    (a) =>
      a.categoryId !== null &&
      a.accountId !== null &&
      mine.has(a.accountId) &&
      (a.fromAccountId === null || !mine.has(a.fromAccountId)) &&
      !moveCategories.has(a.categoryId)
  )
  /**
   * The share of a bill's month that falls in the cycle: its category's regular bills due
   * in it against their monthly run, else the cycle's share of a month.
   */
  const billShare = (categoryId: number) => {
    if (!main) return 1
    const series = input.bills.filter(
      (b) =>
        b.categoryId === categoryId &&
        b.accountId !== null &&
        mine.has(b.accountId)
    )
    const monthly = sum(series.map((b) => b.monthly))
    if (monthly <= 0) return cycle.days / EVERY_DAYS.month
    const inIt = sum(
      series.map((b) => {
        const paid = b.lastDate >= cycle.start && b.lastDate < through ? 1 : 0
        return (paid + datesDue(b, b.days).length) * b.amount
      })
    )
    return inIt / monthly
  }
  const bills = billItems.flatMap((a): TrackedAllocation[] => {
    const done = spentIn(a.categoryId!, (id) => mine.has(id))
    const expected = round2(
      a.amount! * PER_MONTH[a.every] * billShare(a.categoryId!)
    )
    // none due in the cycle: it's not this pay's, unless it went anyway
    const planned = expected >= 1 ? expected : done
    if (planned < 1) return []
    // a bill goes when it's due, not at a pace, so what's gone is what should have
    const byNow = round2(Math.min(done, planned))
    return [
      {
        id: a.id,
        title: a.title,
        purpose: a.purpose,
        to: null,
        amount: a.amount!,
        every: a.every,
        planned,
        byNow,
        done,
        // a bill lands when it lands, so it's behind only once the cycle is out of room
        status: done >= planned - slack(planned) ? "done" : "on_track",
        note: null,
        extra: false,
      },
    ]
  })

  // Cas's moves for this pay that the plan doesn't name, after the plan's took their share
  const accountOf = new Map(pairs.map((p) => [p.outId, p.toAccountId]))
  lines.forEach((l, i) => {
    if (l.planItemId !== null || !mine.has(l.fromAccountId)) return
    const s = lineSchedule(l)
    let done: number | null = null
    if (l.toAccountId !== null) {
      const e = pool.get(`${l.fromAccountId}>${l.toAccountId}`)
      done = e ? round2(Math.min(e.amount, s.planned)) : 0
      if (e) {
        e.amount = Math.max(0, e.amount - done)
        e.outIds.forEach((id) => matched.add(id))
      }
    } else if (l.match !== null) {
      const outs = inCycle.filter(
        (t) =>
          t.accountId === l.fromAccountId &&
          t.amount < 0 &&
          !matched.has(t.id) &&
          !accountOf.has(t.id) &&
          merchantKey(t.description) === l.match
      )
      done = round2(Math.min(-sum(outs.map((t) => t.amount)), s.planned))
      outs.forEach((t) => matched.add(t.id))
    }
    moves.push({
      id: -(i + 1),
      title: l.title,
      purpose: null,
      to:
        l.toAccountId !== null
          ? (input.accountName.get(l.toAccountId) ?? null)
          : null,
      amount: l.amount,
      every: cycle.pay?.every ?? "month",
      ...s,
      done,
      status: status(s.planned, s.byNow, done),
      note: l.reason,
      extra: true,
    })
  })

  const tracked = [...moves, ...bills].filter((a) => a.done !== null)
  const planned = round2(sum([...moves, ...bills].map((a) => a.planned)))

  // transfers out of your accounts that no allocation took
  const isTransfer = (t: MoveTx) =>
    t.categoryId !== null && kind.get(t.categoryId) === "transfer"
  const others = new Map<string, number>()
  for (const t of inCycle) {
    if (!mine.has(t.accountId) || t.amount >= 0 || matched.has(t.id)) continue
    const to = accountOf.get(t.id)
    if (to === undefined && !isTransfer(t)) continue
    if (to !== undefined && mine.has(to)) continue
    const name =
      to !== undefined
        ? (input.accountName.get(to) ?? "Another account")
        : merchantName(merchantKey(t.description))
    others.set(name, (others.get(name) ?? 0) - t.amount)
  }
  const otherParts = [...others]
    .map(([name, amount]) => ({ name, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount)

  // spending: expense and uncategorized money out of your accounts, less what bills and moves count
  const counted = new Set([
    ...moveCategories,
    ...billItems.map((a) => a.categoryId!),
  ])
  const spent = round2(
    -sum(
      inCycle
        .filter(
          (t) =>
            mine.has(t.accountId) &&
            !accountOf.has(t.id) &&
            (t.categoryId === null
              ? t.amount < 0
              : kind.get(t.categoryId) === "expense" &&
                !counted.has(t.categoryId))
        )
        .map((t) => t.amount)
    )
  )

  const soFar = round2(sum(landed.map((t) => t.amount)))
  const stillDue = round2(sum(due.map((p) => p.amount)))
  const total = round2(soFar + stillDue)
  const allowance = round2(Math.max(0, total - planned))
  return {
    cycle: { ...cycle, late: main !== null && cycle.end <= today },
    pay: {
      soFar,
      stillDue,
      total,
      next: main
        ? { date: cycle.end, amount: main.amount }
        : due[0]
          ? { date: due[0].date, amount: due[0].amount }
          : null,
    },
    moves,
    bills,
    planned,
    byNow: round2(sum(tracked.map((a) => a.byNow))),
    done: round2(sum(tracked.map((a) => Math.min(a.done!, a.planned)))),
    otherMoves: {
      amount: round2(sum(otherParts.map((p) => p.amount))),
      parts: otherParts,
    },
    spending: {
      allowance,
      spent,
      byNow: round2(allowance * share),
      left: round2(allowance - spent),
    },
  }
}
