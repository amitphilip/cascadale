// Checking the plan against what really happens. Pure, so the tools and the tests agree.
//
// - Standing rules: decision notes about who pays for something ("Mary pays the school
//   fees"), from the note's subject and payer when it has them, else read from its words.
// - payerConflicts: a plan item about that subject paid by someone else breaks the rule.
// - planVsActual: each plan item against the recurring payments that pay it, who really
//   pays them, and the recurring payments no plan item covers.

import type { PlanEvery, PlanPurpose } from "@/lib/db/schema"
import { CADENCE, type RecurringPayment } from "@/lib/planning/recurring-payments"

const round2 = (n: number) => Math.round(n * 100) / 100 + 0

export const PER_MONTH: Record<PlanEvery, number> = { week: 52 / 12, fortnight: 26 / 12, month: 1, once: 0 }

/** Over this share apart, planned and actual don't agree. */
export const MISMATCH_SHARE = 0.05

export type Member = { id: string; name: string }

export type DecisionNote = {
  id: number
  kind: string
  content: string
  subject: string | null
  payerMemberId: string | null
}

/** A standing rule: this member pays for this. */
export type PayerRule = { noteId: number; subject: string; payerId: string; payer: string; content: string }

/** Lowercase words with a plural "s" dropped, so "school fee" and "School Fees" agree. */
export function stems(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
}

/** Whether every word of `subject` is in `text`. */
export function mentions(text: string, subject: string) {
  const words = new Set(stems(text))
  const want = stems(subject).filter((w) => !["the", "and", "all", "our", "for"].includes(w))
  return want.length > 0 && want.every((w) => words.has(w))
}

/**
 * The payer rules among the decision notes. A note with subject and payer set says so
 * itself; otherwise its words are read for "<member> pays (for) (the) <subject>".
 */
export function payerRules(notes: DecisionNote[], members: Member[]): PayerRule[] {
  const byId = new Map(members.map((m) => [m.id, m]))
  const out: PayerRule[] = []
  for (const n of notes) {
    if (n.kind !== "decision") continue
    if (n.subject && n.payerMemberId && byId.has(n.payerMemberId)) {
      out.push({ noteId: n.id, subject: n.subject, payerId: n.payerMemberId, payer: byId.get(n.payerMemberId)!.name, content: n.content })
      continue
    }
    for (const m of members) {
      const name = m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re = new RegExp(
        `\\b${name}\\s+(?:always\\s+)?(?:pays|covers|pays for|is paying|handles)\\s+(?:for\\s+)?(?:all\\s+)?(?:the\\s+|our\\s+)?([a-z][a-z '&-]{2,40}?)(?=\\s*(?:[.,;:()]|\\band\\b|\\bwith\\b|\\bfrom\\b|\\bout of\\b|$))`,
        "i"
      )
      const match = n.content.match(re)
      if (match) {
        out.push({ noteId: n.id, subject: match[1].trim().toLowerCase(), payerId: m.id, payer: m.name, content: n.content })
        break
      }
    }
  }
  return out
}

/** The fields of a plan item the checks read. */
export type CheckedItem = {
  id: number | null
  title: string
  detail?: string | null
  notes?: string | null
  purpose: PlanPurpose | null
  amount: number | null
  every: PlanEvery | null
  categoryId: number | null
  accountId: number | null
  fromAccountId: number | null
  fromMemberId: string | null
  matchKeys?: string[]
}

/** Whose pay a plan item comes from: its member, else the holder of the account it leaves (or sits in). */
export function payerOf(item: CheckedItem, holderOf: (accountId: number) => string | null) {
  if (item.fromMemberId) return item.fromMemberId
  if (item.fromAccountId !== null) return holderOf(item.fromAccountId)
  if (item.accountId !== null) return holderOf(item.accountId)
  return null
}

export type PayerConflict = {
  noteId: number
  rule: string
  subject: string
  /** who the rule says pays */
  payer: string
  /** who the plan item has paying */
  plannedPayer: string
}

/** The standing rules a plan item breaks: it's about the rule's subject and someone else pays it. */
export function payerConflicts(
  item: CheckedItem,
  rules: PayerRule[],
  holderOf: (accountId: number) => string | null,
  nameOf: (memberId: string) => string
): PayerConflict[] {
  const payer = payerOf(item, holderOf)
  if (payer === null) return []
  const text = [item.title, item.detail, item.notes].filter(Boolean).join(" ")
  return rules
    .filter((r) => r.payerId !== payer && mentions(text, r.subject))
    .map((r) => ({ noteId: r.noteId, rule: r.content, subject: r.subject, payer: r.payer, plannedPayer: nameOf(payer) }))
}

/** Words too common in payment names to tie one to a plan item. */
const GENERIC = new Set([
  "transfer", "payment", "to", "from", "bill", "the", "and", "nz", "ltd", "limited", "new", "zealand",
  "auckland", "account", "mb", "tfr", "fc", "you", "thank", "direct", "debit", "credit", "card",
  "services",
])

/** The distinctive words of a recurring payment's name, leading word first, to look for in a plan item's text. */
function nameWords(p: RecurringPayment) {
  return stems(p.name).filter((w) => w.length >= 3 && !GENERIC.has(w))
}

export type PlanVsActualItem = {
  planItemId: number
  title: string
  purpose: PlanPurpose | null
  plannedMonthly: number
  plannedPayer: string | null
  /** what decided the actual: the recurring payments that pay it, or the category's spending (a budget) */
  basis: "recurring" | "category_spend" | "none"
  actualMonthly: number | null
  /** actual less planned, as a share of planned */
  difference: number | null
  mismatch: boolean
  matched: { key: string; name: string; fromAccount: string; owner: string; cadence: string; typicalAmount: number; monthly: number; matchedBy: string }[]
  /** who the matched payments actually come from */
  actualPayers: string[]
  paidByOther: boolean
  noteConflicts: PayerConflict[]
  flags: string[]
}

export type PlanVsActual = {
  items: PlanVsActualItem[]
  /** recurring payments no plan item covers */
  unplanned: RecurringPayment[]
  rules: PayerRule[]
}

/**
 * Each plan allocation against what pays it. A recurring payment is tied to a plan item by,
 * in order: the item's matchKeys; a transfer from the item's account into its account; the
 * payment's leading name word in the item's title, detail or notes (for a move, only
 * payments out of its own account); and, for an item nothing else matched, its category. A budget item (day-to-day spending) is judged
 * on its category's monthly spending instead.
 */
export function planVsActual(input: {
  items: (CheckedItem & { id: number })[]
  payments: RecurringPayment[]
  /** each category's average monthly spending over the same months */
  categorySpend: Map<number, number>
  rules: PayerRule[]
  holderOf: (accountId: number) => string | null
  nameOf: (memberId: string | null) => string
}): PlanVsActual {
  const { payments } = input
  const items = input.items.filter((i) => i.every !== null && i.every !== "once" && (i.amount ?? 0) > 0)
  const taken = new Map<string, number>()
  const matches = new Map<number, { p: RecurringPayment; by: string }[]>()
  const take = (item: number, p: RecurringPayment, by: string) => {
    if (taken.has(p.key)) return
    taken.set(p.key, item)
    matches.set(item, [...(matches.get(item) ?? []), { p, by }])
  }

  // explicit keys first, then transfers, then names: each payment pays one plan item
  for (const i of items) {
    for (const k of i.matchKeys ?? []) {
      for (const p of payments) if (p.matchKey === k || p.key === k) take(i.id, p, "matchKeys")
    }
  }
  for (const i of items) {
    if (i.fromAccountId === null || i.accountId === null) continue
    for (const p of payments) {
      if (p.fromAccountId === i.fromAccountId && p.toAccountId === i.accountId) take(i.id, p, "transfer")
    }
  }
  for (const i of items) {
    const text = new Set(stems([i.title, i.detail, i.notes].filter(Boolean).join(" ")))
    for (const p of payments) {
      // a transfer is matched by its accounts; a payment by its merchant's leading word
      // ("Spark" for Spark NZ Trading, "Cabin" for Cabin King)
      const lead = p.kind === "payment" ? nameWords(p)[0] : undefined
      // a move is paid out of its own account; what that money then pays isn't the move
      if (i.fromAccountId !== null && p.fromAccountId !== i.fromAccountId) continue
      if (lead && text.has(lead)) take(i.id, p, "name")
    }
  }
  for (const i of items) {
    if (matches.has(i.id) || i.categoryId === null || i.purpose === "budget") continue
    for (const p of payments) if (p.kind === "payment" && p.categoryId === i.categoryId) take(i.id, p, "category")
  }

  const out = items.map((i): PlanVsActualItem => {
    const planned = round2((i.amount ?? 0) * PER_MONTH[i.every!])
    const matched = matches.get(i.id) ?? []
    const plannedPayerId = payerOf(i, input.holderOf)
    let basis: PlanVsActualItem["basis"] = "none"
    let actual: number | null = null
    if (matched.length) {
      basis = "recurring"
      actual = round2(matched.reduce((s, m) => s + m.p.typicalAmount * CADENCE[m.p.cadence].perMonth, 0))
    } else if (i.purpose === "budget" && i.categoryId !== null && input.categorySpend.has(i.categoryId)) {
      basis = "category_spend"
      actual = round2(input.categorySpend.get(i.categoryId)!)
    }
    const difference = actual === null || planned === 0 ? null : round2((actual - planned) / planned)
    const payers = [...new Set(matched.map((m) => m.p.ownerId))]
    const actualPayers = payers.map((id) => input.nameOf(id))
    // a payment from a joint account isn't someone else's
    const paidByOther =
      plannedPayerId !== null && payers.some((id) => id !== null && id !== plannedPayerId)
    const noteConflicts = payerConflicts(i, input.rules, input.holderOf, (id) => input.nameOf(id))
    const mismatch = difference !== null && Math.abs(difference) > MISMATCH_SHARE
    const flags = [
      ...(mismatch
        ? [`Planned ${planned.toFixed(2)}/mo, actually ${actual!.toFixed(2)}/mo (${difference! > 0 ? "+" : ""}${Math.round(difference! * 100)}%)`]
        : []),
      ...(basis === "none" ? ["No recurring payment or spending found for it"] : []),
      ...(paidByOther ? [`The plan has ${input.nameOf(plannedPayerId)} paying, but it comes from ${actualPayers.join(" and ")}`] : []),
      ...noteConflicts.map((c) => `The plan has ${c.plannedPayer} paying "${c.subject}", but a decision note says ${c.payer} pays it`),
    ]
    return {
      planItemId: i.id,
      title: i.title,
      purpose: i.purpose,
      plannedMonthly: planned,
      plannedPayer: plannedPayerId === null ? null : input.nameOf(plannedPayerId),
      basis,
      actualMonthly: actual,
      difference,
      mismatch,
      matched: matched.map(({ p, by }) => ({
        key: p.key,
        name: p.name,
        fromAccount: p.fromAccount,
        owner: p.owner,
        cadence: p.cadence,
        typicalAmount: p.typicalAmount,
        monthly: p.monthly,
        matchedBy: by,
      })),
      actualPayers,
      paidByOther,
      noteConflicts,
      flags,
    }
  })

  return {
    items: out,
    unplanned: payments.filter((p) => !taken.has(p.key)),
    rules: input.rules,
  }
}
