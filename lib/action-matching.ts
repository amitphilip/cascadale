import { addDays, format, parseISO } from "date-fns"

import type { PlanAction } from "@/lib/db/schema"

/**
 * Whether new transactions show an action item was done: one that moves an amount out of
 * or into an account (or between two) is matched on the amount to the cent, the accounts and
 * a date window. One clear match is confident; more than one, or only half of a transfer,
 * is ambiguous and goes to a person as a proposal. Pure functions.
 */

/** A transfer's two sides land within this many days of each other. */
export const PAIR_DAYS = 3
/** A match can come this many days before the item was added (it may have been done already)… */
export const BEFORE_DAYS = 3
/** …and this many after its due date. */
export const AFTER_DUE_DAYS = 14

export type MatchTx = { id: number; accountId: number; date: string; amount: number; description: string }

export type ActionMatch =
  | { actionId: number; kind: "confident"; transactionId: number; transactionIds: number[] }
  | { actionId: number; kind: "ambiguous"; candidates: MatchTx[] }

const iso = (d: Date) => format(d, "yyyy-MM-dd")
const cents = (n: number) => Math.round(n * 100)
const dayGap = (a: string, b: string) => Math.abs(parseISO(a).getTime() - parseISO(b).getTime()) / 86_400_000

/** Action items that can be matched: open, with an amount and at least one account. */
export const matchable = (a: PlanAction) =>
  a.doneAt === null && !!a.amount && a.amount > 0 && (a.fromAccountId != null || a.toAccountId != null)

export function matchActions(actions: PlanAction[], txs: MatchTx[], today: string): ActionMatch[] {
  // a transaction that already showed one item was done can't show another was
  const claimed = new Set(actions.flatMap((a) => (a.doneTransactionId ? [a.doneTransactionId] : [])))
  const out: ActionMatch[] = []
  // oldest first, so an earlier item gets the earlier transaction
  for (const a of actions.filter(matchable).toSorted((x, y) => x.id - y.id)) {
    const from = iso(addDays(parseISO(a.createdAt.slice(0, 10)), -BEFORE_DAYS))
    const to = a.dueDate ? iso(addDays(parseISO(a.dueDate), AFTER_DUE_DAYS)) : today
    const amount = cents(a.amount!)
    const inWindow = txs.filter((t) => !claimed.has(t.id) && t.date >= from && t.date <= to)
    const outs = a.fromAccountId != null ? inWindow.filter((t) => t.accountId === a.fromAccountId && cents(t.amount) === -amount) : []
    const ins = a.toAccountId != null ? inWindow.filter((t) => t.accountId === a.toAccountId && cents(t.amount) === amount) : []

    let match: ActionMatch | null = null
    if (a.fromAccountId != null && a.toAccountId != null) {
      const pairs = outs.flatMap((o) => ins.filter((i) => dayGap(o.date, i.date) <= PAIR_DAYS).map((i) => [o, i] as const))
      if (pairs.length === 1) {
        const [o, i] = pairs[0]
        match = { actionId: a.id, kind: "confident", transactionId: o.id, transactionIds: [o.id, i.id] }
      } else if (pairs.length > 1) {
        match = { actionId: a.id, kind: "ambiguous", candidates: [...new Set(pairs.flat())] }
      } else if (outs.length + ins.length > 0) {
        // only one side showed up: the other account may not have synced yet
        match = { actionId: a.id, kind: "ambiguous", candidates: [...outs, ...ins] }
      }
    } else {
      const side = a.fromAccountId != null ? outs : ins
      if (side.length === 1) match = { actionId: a.id, kind: "confident", transactionId: side[0].id, transactionIds: [side[0].id] }
      else if (side.length > 1) match = { actionId: a.id, kind: "ambiguous", candidates: side }
    }
    if (!match) continue
    if (match.kind === "confident") for (const id of match.transactionIds) claimed.add(id)
    out.push(match)
  }
  return out
}
