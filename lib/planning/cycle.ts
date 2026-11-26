// Where one member stands in their pay cycle: what's come in, what the plan and this pay's
// short-term lines have moved and still have to, the bills still to go before the next
// payday, and what that leaves in the account the pay lands in. Pure; the figures that
// preview_short_term and what_if stand on.

import type { MyAllocation } from "@/lib/my-allocation"
import { datesBetween, type RecurringPayment } from "@/lib/planning/recurring-payments"
import type { ShortTermLine } from "@/lib/short-term"

const round2 = (n: number) => Math.round(n * 100) / 100 + 0
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

export type PayDue = { accountId: number; date: string; amount: number; name: string }

export type CycleEvent = {
  date: string
  kind: "pay" | "move" | "bill"
  title: string
  accountId: number
  /** positive in, negative out */
  amount: number
}

export type CyclePosition = {
  cycle: {
    start: string
    /** the next payday */
    end: string
    days: number
    daysLeft: number
    late: boolean
    pay: { name: string; every: string; amount: number } | null
  }
  pay: MyAllocation["pay"]
  payAccount: { id: number; name: string; balance: number } | null
  moves: {
    id: number
    title: string
    fromAccountId: number | null
    from: string | null
    to: string | null
    planned: number
    done: number | null
    left: number
    status: string
    /** a short-term line's reason, or null */
    note: string | null
    /** a line of this pay's short-term allocation the plan doesn't name */
    extra: boolean
  }[]
  movesDone: number
  movesLeft: number
  billsDue: { name: string; date: string; amount: number; fromAccountId: number; from: string; key: string; confidence: string }[]
  paysDue: PayDue[]
  /** the pay account's balance plus the pays still due into it, less the moves and bills still to come out of it */
  leftInPayAccount: number | null
  /** the same across every account of theirs */
  leftInYourAccounts: number
  /** outgoings the pay account can't cover when they fall due, in date order */
  uncovered: { date: string; title: string; kind: "move" | "bill"; amount: number; short: number }[]
  spending: MyAllocation["spending"]
}

/**
 * A member's position in the pay cycle from their allocation (lib/my-allocation.ts, with the
 * short-term lines applied), account balances and recurring payments. Recurring payments in
 * `covered` are already a plan move (or a transfer between their own accounts) and aren't
 * counted again as bills.
 */
export function cyclePosition(input: {
  today: string
  allocation: MyAllocation
  /** the plan's allocations, for where each move leaves from */
  planItems: { id: number; fromAccountId: number | null }[]
  lines: ShortTermLine[]
  mine: number[]
  balances: Map<number, number>
  accountName: Map<number, string>
  payments: RecurringPayment[]
  covered: Set<string>
  paysDue: PayDue[]
}): CyclePosition {
  const { today, allocation: a } = input
  const mine = new Set(input.mine)
  const end = a.cycle.end > today ? a.cycle.end : today
  const fromOf = new Map(input.planItems.map((i) => [i.id, i.fromAccountId]))
  const name = (id: number | null) => (id === null ? null : (input.accountName.get(id) ?? null))
  const payAccountId = a.cycle.pay?.accountId ?? (input.paysDue[0]?.accountId ?? input.mine[0] ?? null)

  const moves = a.moves.map((m) => {
    const fromAccountId = m.id > 0 ? (fromOf.get(m.id) ?? null) : (input.lines[-m.id - 1]?.fromAccountId ?? null)
    const left = round2(Math.max(0, m.planned - (m.done ?? 0)))
    return {
      id: m.id,
      title: m.title,
      fromAccountId,
      from: name(fromAccountId),
      to: m.to,
      planned: m.planned,
      done: m.done,
      left,
      status: m.status,
      note: m.note,
      extra: m.extra,
    }
  })

  const billsDue = input.payments
    .filter(
      (p) =>
        mine.has(p.fromAccountId) &&
        !input.covered.has(p.key) &&
        !(p.toAccountId !== null && mine.has(p.toAccountId))
    )
    .flatMap((p) =>
      datesBetween(p, today, end).map((date) => ({
        name: p.name,
        date,
        amount: p.typicalAmount,
        fromAccountId: p.fromAccountId,
        from: p.fromAccount,
        key: p.key,
        confidence: p.confidence,
      }))
    )
    .sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount)

  const paysDue = input.paysDue
    .filter((p) => mine.has(p.accountId) && p.date >= today && p.date < end)
    .sort((x, y) => x.date.localeCompare(y.date))

  const events: CycleEvent[] = [
    ...paysDue.map((p) => ({ date: p.date, kind: "pay" as const, title: p.name, accountId: p.accountId, amount: p.amount })),
    // a move still to make goes now: the plan has it due from payday
    ...moves
      .filter((m) => m.left > 0 && m.fromAccountId !== null)
      .map((m) => ({ date: today, kind: "move" as const, title: m.title, accountId: m.fromAccountId!, amount: -m.left })),
    ...billsDue.map((b) => ({ date: b.date, kind: "bill" as const, title: b.name, accountId: b.fromAccountId, amount: -b.amount })),
  ].sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount)

  const leftIn = (accountId: number) =>
    round2((input.balances.get(accountId) ?? 0) + sum(events.filter((e) => e.accountId === accountId).map((e) => e.amount)))

  // run the pay account forward to see what it can't cover when it falls due
  const uncovered: CyclePosition["uncovered"] = []
  if (payAccountId !== null) {
    let balance = input.balances.get(payAccountId) ?? 0
    for (const e of events.filter((x) => x.accountId === payAccountId)) {
      balance = round2(balance + e.amount)
      if (e.amount < 0 && balance < 0) {
        // all of it when the account was already short, else the part past zero
        const short = round2(Math.min(-e.amount, -balance))
        uncovered.push({ date: e.date, title: e.title, kind: e.kind as "move" | "bill", amount: -e.amount, short })
      }
    }
  }

  return {
    cycle: {
      start: a.cycle.start,
      end: a.cycle.end,
      days: a.cycle.days,
      daysLeft: Math.max(0, Math.round((Date.parse(a.cycle.end) - Date.parse(today)) / 86_400_000)),
      late: a.cycle.late,
      pay: a.cycle.pay && { name: a.cycle.pay.name, every: a.cycle.pay.every, amount: a.cycle.pay.amount },
    },
    pay: a.pay,
    payAccount:
      payAccountId === null
        ? null
        : { id: payAccountId, name: name(payAccountId) ?? "Pay account", balance: round2(input.balances.get(payAccountId) ?? 0) },
    moves,
    movesDone: round2(sum(moves.map((m) => Math.min(m.done ?? 0, m.planned)))),
    movesLeft: round2(sum(moves.map((m) => m.left))),
    billsDue,
    paysDue,
    leftInPayAccount: payAccountId === null ? null : leftIn(payAccountId),
    leftInYourAccounts: round2(sum(input.mine.map(leftIn))),
    uncovered,
    spending: a.spending,
  }
}
