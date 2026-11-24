// Home's month: money in and out so far, what's expected by the month's end, where spending
// is heading, and each budget's spending broken down by merchant. Pure, so Home, Cas's
// briefing and the tests agree.
//
// - In so far: income categories and uncategorized money in (refunds net off spending).
// - In expected: in so far plus the regular pays still due this month (late ones counted,
//   missed ones not), as the briefing's incomeByMonthEnd.
// - Out so far: spending in expense categories (refunds netted), uncategorized money out,
//   and what's been paid for one-off payments.
// - Out expected: the plan for the month: each category's budget, or its projection where
//   it has none, plus the one-off payments due to go out this month.
// - Out projected: where the month is heading: spent so far, plus the bills still due,
//   plus each category's everyday share (its plan less its bills) for the days left.
//   Exactly the plan when everything runs to pace.

import { elapsed, monthOf, trackBudgets, weekOf, type Pace } from "@/lib/budget-tracking"
import type { Category } from "@/lib/db/schema"
import { expectedFrom, type PayDue } from "@/lib/income"
import type { CategoryFigure } from "@/lib/plan-figures"
import { merchantKey } from "@/lib/rules"
import type { SpendTx } from "@/lib/queries"
import { merchantName } from "@/supabase/functions/_shared/cas-queue"

/** A category whose projection is at least this share recurring bills is a bill, not everyday. */
export const BILL_SHARE = 0.5

// + 0 turns -0 into 0
const round2 = (n: number) => Math.round(n * 100) / 100 + 0
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

export type MerchantSpend = {
  key: string
  name: string
  /** net of refunds */
  spent: number
  txs: SpendTx[]
}

export type TrackGroup = "bills" | "everyday" | "one_offs"

export type TrackRow = {
  /** "c:<id>", "c:none" for uncategorized, "o:<id>" for a one-off payment */
  key: string
  group: TrackGroup
  categoryId: number | null
  oneOffId: number | null
  name: string
  /** the period its spending and budget are for: this week for a weekly budget */
  period: "week" | "month"
  spent: number
  budget: number | null
  /** what the budget allows by now at an even pace */
  expected: number | null
  pace: Pace | null
  /** bills still to go out this month; for a one-off, what's still to pay out this month */
  due: number
  merchants: MerchantSpend[]
}

export type MonthOneOff = {
  id: number
  name: string
  /** what the one-off's plan still pays out this month */
  outThisMonth: number
}

export type MonthFigures = {
  month: { start: string; last: string; daysLeft: number; share: number }
  in: { soFar: number; stillDue: PayDue[]; expected: number }
  out: { soFar: number; planned: number; projected: number; /** projected less planned */ diff: number }
  /** in expected less out projected */
  net: number
  leftToSpend: { amount: number; perDay: number; budgeted: number; spent: number; unbudgeted: number }
  rows: TrackRow[]
  /** the same so-far figures for the accounts marked as yours */
  yours: { in: number; out: number } | null
}

export function monthFigures(input: {
  today: string
  /** spending transactions from the earlier of this week's and this month's start */
  txs: SpendTx[]
  categories: Category[]
  projection: CategoryFigure[]
  paysDue: PayDue[]
  billsDue: (PayDue & { categoryId: number | null })[]
  oneOffs: MonthOneOff[]
  /** your accounts, for the My view's line; null for the household */
  mine: number[] | null
}): MonthFigures {
  const { today, txs, categories } = input
  const month = monthOf(today)
  const week = weekOf(today)
  const share = elapsed(month, today)
  const left = 1 - share
  const last = `${today.slice(0, 7)}-${String(month.days).padStart(2, "0")}`
  const daysLeft = month.days - Number(today.slice(8, 10)) + 1

  const kind = new Map(categories.map((c) => [c.id, c.kind]))
  const inMonth = txs.filter((t) => t.date >= month.start && t.date < month.end)
  const inWeek = txs.filter((t) => t.date >= week.start && t.date < week.end)

  const isIn = (t: SpendTx) =>
    t.oneOffId === null &&
    (t.categoryId === null ? t.amount > 0 : kind.get(t.categoryId) === "income")
  /** counted in a category's spending: expense categories, and uncategorized money out */
  const isSpend = (t: SpendTx) =>
    t.oneOffId === null &&
    (t.categoryId === null ? t.amount < 0 : kind.get(t.categoryId) === "expense")
  const isOneOffOut = (t: SpendTx) => t.oneOffId !== null && t.amount < 0

  const totals = (list: SpendTx[]) => ({
    in: round2(sum(list.filter(isIn).map((t) => t.amount))),
    out: round2(-sum(list.filter((t) => isSpend(t) || isOneOffOut(t)).map((t) => t.amount))),
  })

  const spendBy = (list: SpendTx[]) => {
    const m = new Map<number | null, number>()
    for (const t of list.filter(isSpend)) m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amount)
    return m
  }
  const monthSpend = spendBy(inMonth)
  const weekSpend = spendBy(inWeek)
  const ids = (m: Map<number | null, number>) =>
    new Map([...m].flatMap(([id, v]) => (id === null ? [] : [[id, v] as const])))

  const projection = new Map(input.projection.map((p) => [p.categoryId, p]))
  const due = new Map<number | null, number>()
  for (const b of input.billsDue) {
    if (b.status !== "missed") due.set(b.categoryId, (due.get(b.categoryId) ?? 0) + b.amount)
  }
  const isBill = (id: number | null) => {
    const p = projection.get(id)
    return !!p && p.projected > 0 && p.recurring / p.projected >= BILL_SHARE
  }

  const merchants = (list: SpendTx[]): MerchantSpend[] => {
    const groups = new Map<string, SpendTx[]>()
    for (const t of list) {
      const k = merchantKey(t.description)
      groups.set(k, [...(groups.get(k) ?? []), t])
    }
    return [...groups]
      .map(([key, g]) => ({ key, name: merchantName(key), spent: round2(-sum(g.map((t) => t.amount))), txs: g }))
      .sort((a, b) => b.spent - a.spent)
  }
  const spendTxsOf = (id: number | null, period: "week" | "month") =>
    (period === "week" ? inWeek : inMonth).filter((t) => isSpend(t) && t.categoryId === id)

  // budgeted categories, each against its own period
  const tracked = trackBudgets(categories, { month: ids(monthSpend), week: ids(weekSpend) }, today)
  const rows: TrackRow[] = tracked.map((b) => ({
    key: `c:${b.id}`,
    group: isBill(b.id) ? "bills" : "everyday",
    categoryId: b.id,
    oneOffId: null,
    name: b.name,
    period: b.period,
    spent: round2(b.spent),
    budget: round2(b.budget),
    expected: round2(b.expected),
    pace: b.pace,
    due: round2(due.get(b.id) ?? 0),
    merchants: merchants(spendTxsOf(b.id, b.period)),
  }))

  // spending with no budget, and bills still due in categories with none
  const budgeted = new Set(tracked.map((b) => b.id))
  const unbudgeted = categories
    .filter((c) => c.kind === "expense" && !budgeted.has(c.id))
    .map((c) => ({ id: c.id as number | null, name: c.name }))
    .concat([{ id: null, name: "Uncategorized" }])
    .filter((c) => (monthSpend.get(c.id) ?? 0) !== 0 || (due.get(c.id) ?? 0) > 0)
    .map(
      (c): TrackRow => ({
        key: `c:${c.id ?? "none"}`,
        group: c.id !== null && isBill(c.id) ? "bills" : "everyday",
        categoryId: c.id,
        oneOffId: null,
        name: c.name,
        period: "month",
        spent: round2(monthSpend.get(c.id) ?? 0),
        budget: null,
        expected: null,
        pace: null,
        due: round2(due.get(c.id) ?? 0),
        merchants: merchants(spendTxsOf(c.id, "month")),
      })
    )
    .sort((a, b) => (a.categoryId === null ? 1 : b.categoryId === null ? -1 : b.spent - a.spent))

  // one-off payments: paid this month, or due to be
  const oneOffRows = input.oneOffs
    .map((o): TrackRow => {
      const linked = inMonth.filter((t) => t.oneOffId === o.id)
      const paid = round2(-sum(linked.filter((t) => t.amount < 0).map((t) => t.amount)))
      return {
        key: `o:${o.id}`,
        group: "one_offs",
        categoryId: null,
        oneOffId: o.id,
        name: o.name,
        period: "month",
        spent: paid,
        budget: round2(paid + o.outThisMonth),
        expected: null,
        pace: null,
        due: round2(o.outThisMonth),
        merchants: merchants(linked),
      }
    })
    .filter((r) => r.spent > 0 || r.due > 0 || r.merchants.length > 0)

  // trackBudgets has the budgeted ones most urgent first
  const ordered = rows.concat(unbudgeted, oneOffRows)

  // the month's plan and where it's heading, category by category
  const planIds = new Set<number | null>([
    // uncategorized money out, whether or not the plan projects any
    null,
    ...categories.filter((c) => c.kind === "expense").map((c) => c.id),
    ...input.projection.map((p) => p.categoryId),
  ])
  const budgetOf = new Map(
    categories.flatMap((c) => (c.kind === "expense" && c.monthlyBudget !== null ? [[c.id, Number(c.monthlyBudget)] as const] : []))
  )
  let planned = 0
  let projected = 0
  for (const id of planIds) {
    const p = projection.get(id)
    const plan = (id !== null ? budgetOf.get(id) : undefined) ?? p?.projected ?? 0
    const everyday = Math.max(0, plan - (p?.recurring ?? 0))
    planned += plan
    projected += (monthSpend.get(id) ?? 0) + (due.get(id) ?? 0) + everyday * left
  }
  const oneOffPaid = sum(oneOffRows.map((r) => r.spent))
  const oneOffDue = sum(input.oneOffs.map((o) => o.outThisMonth))
  planned += oneOffPaid + oneOffDue
  projected += oneOffPaid + oneOffDue

  // left to spend: the everyday budgets this month, less what's gone on them and on
  // categories with no budget (bills aren't counted; they're already planned for)
  const everydayBudgets = categories.filter(
    (c) => c.kind === "expense" && budgetOf.has(c.id) && budgetOf.get(c.id)! > 0 && !isBill(c.id)
  )
  const ltsBudgeted = sum(everydayBudgets.map((c) => budgetOf.get(c.id)!))
  const ltsSpent = sum(everydayBudgets.map((c) => Math.max(0, monthSpend.get(c.id) ?? 0)))
  const ltsUnbudgeted = sum(
    categories
      .filter((c) => c.kind === "expense" && !budgetOf.get(c.id))
      .map((c) => Math.max(0, monthSpend.get(c.id) ?? 0))
  )
  const ltsAmount = round2(ltsBudgeted - ltsSpent - ltsUnbudgeted)

  const so = totals(inMonth)
  const expectedIn = round2(so.in + expectedFrom(input.paysDue))
  const mine = input.mine ? new Set(input.mine) : null

  return {
    month: { start: month.start, last, daysLeft, share },
    in: { soFar: so.in, stillDue: input.paysDue, expected: expectedIn },
    out: {
      soFar: so.out,
      planned: round2(planned),
      projected: round2(projected),
      diff: round2(projected - planned),
    },
    net: round2(expectedIn - projected),
    leftToSpend: {
      amount: ltsAmount,
      perDay: ltsAmount > 0 && daysLeft > 0 ? round2(ltsAmount / daysLeft) : 0,
      budgeted: round2(ltsBudgeted),
      spent: round2(ltsSpent),
      unbudgeted: round2(ltsUnbudgeted),
    },
    rows: ordered,
    yours: mine ? totals(inMonth.filter((t) => mine.has(t.accountId))) : null,
  }
}
