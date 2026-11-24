// The My view's allocation: what the plan does with your pay this month, and how it's going.
// Pure, so Home and the tests agree.
//
// - Your pay: the pays into your accounts this month, landed and still due.
// - Moves: each allocation leaving one of your accounts. Its month is its amount per pay
//   times your pays this month when it runs on your pay's cadence, else its monthly
//   equivalent. By now, the share of that for the pays that have landed.
//   Done: the transfers from that account into the allocation's account this month (both
//   sides paired), or, for one tied to a category, that category's spending from it.
// - Bills: allocations that sit in one of your accounts with a category, paid from there:
//   that category's spending from your accounts against the month's amount.
// - Your spending: your pay less the moves and bills, against everything else spent from
//   your accounts so far. Transfers out the plan doesn't name show as other moves.

import { elapsed, monthOf } from "@/lib/budget-tracking"
import type {
  Category,
  PlanEvery,
  PlanItem,
  PlanPurpose,
} from "@/lib/db/schema"
import type { PayDue } from "@/lib/income"
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

/** A few dollars short of the mark still counts as done. */
const slack = (n: number) => Math.max(5, n * 0.02)

export type PayEvery = Exclude<PlanEvery, "once">

/** Any transaction this month, transfers included. */
export type MoveTx = {
  id: number
  accountId: number
  date: string
  description: string
  /** signed: negative is money out */
  amount: number
  categoryId: number | null
}

export type AllocationStatus = "done" | "on_track" | "behind" | "untracked"

export type TrackedAllocation = {
  id: number
  title: string
  purpose: PlanPurpose | null
  /** where it goes, by account name, when the plan says */
  to: string | null
  amount: number
  every: PayEvery
  /** what the plan has for it this month */
  month: number
  /** what should have gone by now; for a bill, what has (bills go when they're due) */
  byNow: number
  /** what has gone; null when there's no way to tell (no account or category to match) */
  done: number | null
  status: AllocationStatus
}

export type MyAllocation = {
  pay: {
    soFar: number
    stillDue: number
    total: number
    /** the next pay still to land into your accounts this month */
    next: { date: string; amount: number } | null
  }
  moves: TrackedAllocation[]
  bills: TrackedAllocation[]
  /** the plan's moves and bills this month */
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
  /** this month's transactions in every account, transfers included */
  txs: MoveTx[]
  categories: Pick<Category, "id" | "kind">[]
  paysDue: PayDue[]
  /** how often each account's main pay comes */
  payEvery: Map<number, PayEvery>
  accountName: Map<number, string>
}): MyAllocation {
  const { today, txs } = input
  const month = monthOf(today)
  const share = elapsed(month, today)
  const mine = new Set(input.mine)
  const kind = new Map(input.categories.map((c) => [c.id, c.kind]))
  const inMonth = txs.filter((t) => t.date >= month.start && t.date < month.end)

  // pays: income of a pay's size into your accounts, and the regular ones still due
  const isPay = (t: MoveTx) =>
    t.categoryId !== null &&
    kind.get(t.categoryId) === "income" &&
    t.amount >= PAY_MIN
  const landed = inMonth.filter((t) => mine.has(t.accountId) && isPay(t))
  const due = input.paysDue
    .filter(
      (p) =>
        mine.has(p.accountId) && p.status !== "missed" && p.amount >= PAY_MIN
    )
    .sort((a, b) => a.date.localeCompare(b.date))
  const paysInto = (accountId: number) => ({
    landed: landed.filter((t) => t.accountId === accountId).length,
    due: due.filter((p) => p.accountId === accountId).length,
  })

  /** the month's amount and what's due by now, on the pays into `from` */
  const schedule = (amount: number, every: PayEvery, from: number | null) => {
    const pays = from === null ? { landed: 0, due: 0 } : paysInto(from)
    const count = pays.landed + pays.due
    const onPay =
      from !== null && input.payEvery.get(from) === every && count > 0
    const monthAmount = onPay ? amount * count : amount * PER_MONTH[every]
    const byNow =
      count > 0 ? (monthAmount * pays.landed) / count : monthAmount * share
    return { month: round2(monthAmount), byNow: round2(byNow) }
  }

  const spentIn = (categoryId: number, accounts: (id: number) => boolean) =>
    round2(
      -sum(
        inMonth
          .filter((t) => t.categoryId === categoryId && accounts(t.accountId))
          .map((t) => t.amount)
      )
    )

  // transfers between accounts, paired; each out side is matched to at most one allocation
  const pairs = pairTransfers(inMonth)
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
    month: number,
    byNow: number,
    done: number | null
  ): AllocationStatus =>
    done === null
      ? "untracked"
      : done >= month - slack(month)
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
    .map((a) => {
      const from = a.fromAccountId!
      const s = schedule(a.amount!, a.every, from)
      let done: number | null = null
      if (a.categoryId !== null) {
        done = spentIn(a.categoryId, (id) => id === from)
      } else if (a.accountId !== null) {
        // allocations into the same account share what moved there, in plan order
        const e = pool.get(`${from}>${a.accountId}`)
        done = e ? round2(Math.min(e.amount, s.month)) : 0
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
        status: status(s.month, s.byNow, done),
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
  const bills: TrackedAllocation[] = billItems.map((a) => {
    const monthAmount = round2(a.amount! * PER_MONTH[a.every])
    const done = spentIn(a.categoryId!, (id) => mine.has(id))
    // a bill goes when it's due, not at a pace, so what's gone is what should have
    const byNow = round2(Math.min(done, monthAmount))
    return {
      id: a.id,
      title: a.title,
      purpose: a.purpose,
      to: null,
      amount: a.amount!,
      every: a.every,
      month: monthAmount,
      byNow,
      done,
      // a bill lands when it lands, so it's behind only once the month is out of room
      status: done >= monthAmount - slack(monthAmount) ? "done" : "on_track",
    }
  })

  const tracked = [...moves, ...bills].filter((a) => a.done !== null)
  const planned = round2(sum([...moves, ...bills].map((a) => a.month)))

  // transfers out of your accounts that no allocation took
  const accountOf = new Map(pairs.map((p) => [p.outId, p.toAccountId]))
  const isTransfer = (t: MoveTx) =>
    t.categoryId !== null && kind.get(t.categoryId) === "transfer"
  const others = new Map<string, number>()
  for (const t of inMonth) {
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
      inMonth
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
    pay: {
      soFar,
      stillDue,
      total,
      next: due[0] ? { date: due[0].date, amount: due[0].amount } : null,
    },
    moves,
    bills,
    planned,
    byNow: round2(sum(tracked.map((a) => a.byNow))),
    done: round2(sum(tracked.map((a) => Math.min(a.done!, a.month)))),
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
