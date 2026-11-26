// The short-term allocation's pure parts: what a line is, the moves out of your accounts in
// the pay cycle as Cas reads them, and the fingerprint that says when to look again.
// The plan is the long-term allocation; these are this pay's transfers (see
// supabase/migrations/20261126000000_short_term_allocations.sql).

import { createHash } from "node:crypto"

import { merchantKey } from "@/supabase/functions/_shared/rules"
import { pairTransfers } from "@/supabase/functions/_shared/transfers"

/** One transfer for this pay: this much from here to there. */
export type ShortTermLine = {
  id: string
  /** the plan allocation it sets this pay's amount for; null for a move the plan doesn't name */
  planItemId: number | null
  title: string
  fromAccountId: number
  /** where it goes, when that's one of the household's accounts */
  toAccountId: number | null
  /** when the money leaves the household: the merchant key its transactions carry */
  match: string | null
  amount: number
  /** when it should have gone by; null for straight away */
  dueDate: string | null
  reason: string
  /** cas: the old Cas agent decided it; claude: Claude set it through the MCP tools; you: set in the app */
  by: "cas" | "claude" | "you"
}

type Tx = {
  id: number
  accountId: number
  date: string
  description: string
  amount: number
  categoryId: number | null
}

/** A move out of one of your accounts in the cycle: a transfer, or money that left the household. */
export type CycleMove = {
  id: number
  date: string
  fromAccountId: number
  /** the household account it went into, when both sides are synced */
  toAccountId: number | null
  /** the merchant key, for one with no other side */
  match: string | null
  description: string
  amount: number
}

/**
 * Money that left your accounts in the cycle other than spending: transfers paired with
 * another account, and unpaired money out categorized as a transfer.
 */
export function cycleMoves(input: {
  txs: Tx[]
  mine: number[]
  transferCategories: Set<number>
  start: string
  through: string
}): CycleMove[] {
  const mine = new Set(input.mine)
  const inCycle = input.txs.filter((t) => t.date >= input.start && t.date < input.through)
  const to = new Map(pairTransfers(inCycle).map((p) => [p.outId, p.toAccountId]))
  return inCycle
    .filter(
      (t) =>
        mine.has(t.accountId) &&
        t.amount < 0 &&
        (to.has(t.id) || (t.categoryId !== null && input.transferCategories.has(t.categoryId)))
    )
    .map((t) => ({
      id: t.id,
      date: t.date,
      fromAccountId: t.accountId,
      toAccountId: to.get(t.id) ?? null,
      match: to.has(t.id) ? null : merchantKey(t.description),
      description: t.description,
      amount: Math.round(-t.amount * 100) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
}

/**
 * What the short-term allocation is worked out from: the cycle, the plan, and the pays and
 * moves in it. Spending isn't in it, so a coffee doesn't send Cas to look again.
 */
export function shortTermFingerprint(input: {
  cycleStart: string
  planId: number
  /** the cycle's pays into your accounts, by transaction id */
  pays: number[]
  moves: CycleMove[]
}) {
  const basis = JSON.stringify([
    input.cycleStart,
    input.planId,
    [...input.pays].sort((a, b) => a - b),
    input.moves.map((m) => [m.id, m.amount, m.toAccountId]),
  ])
  return createHash("sha256").update(basis).digest("hex").slice(0, 32)
}

/**
 * Lines with ids the data doesn't have taken out: a plan allocation not leaving your
 * accounts, an account that isn't the household's, money from an account that isn't yours.
 */
export function cleanLines(
  lines: Omit<ShortTermLine, "id">[],
  known: { mine: Set<number>; accounts: Set<number>; planItems: Set<number> }
): ShortTermLine[] {
  return lines.flatMap((l, i) => {
    if (!known.mine.has(l.fromAccountId) || !(l.amount >= 0)) return []
    const toAccountId = l.toAccountId !== null && known.accounts.has(l.toAccountId) ? l.toAccountId : null
    const match = toAccountId === null ? l.match?.trim().toLowerCase() || null : null
    return [
      {
        ...l,
        id: `l${i + 1}`,
        planItemId: l.planItemId !== null && known.planItems.has(l.planItemId) ? l.planItemId : null,
        toAccountId,
        match,
        amount: Math.round(l.amount * 100) / 100,
        dueDate: l.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(l.dueDate) ? l.dueDate : null,
      },
    ]
  })
}
