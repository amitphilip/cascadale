import "server-only"

import { getDb, getUserId, must } from "@/lib/db"
import type { CasNote } from "@/lib/db/schema"
import { myAllocation, type PayEvery } from "@/lib/my-allocation"
import { planOneOff } from "@/lib/one-offs"
import { cardPositions } from "@/lib/planning/card"
import { cyclePosition, type PayDue } from "@/lib/planning/cycle"
import { PER_MONTH, payerRules, planVsActual, type Member } from "@/lib/planning/plan-check"
import {
  CADENCE,
  addDays,
  datesBetween,
  daysBetween,
  detectRecurringPayments,
  groupKey,
  monthsBefore,
  type PaymentTx,
  type RecurringPayment,
} from "@/lib/planning/recurring-payments"
import type { BufferPot, CycleModel, Goal } from "@/lib/planning/what-if"
import { getAccountHolders, getAccountsWithBalances, getCategories, getMonthMoves, getOneOffs, getPeople } from "@/lib/queries"
import { cleanLines, type ShortTermLine } from "@/lib/short-term"
import { getShortTerm } from "@/lib/short-term-data"
import { knownIds, loadBasis } from "@/lib/planning/short-term"
import { todayLocal } from "@/supabase/functions/_shared/akahu"
import { pairTransfers } from "@/supabase/functions/_shared/transfers"

// What the planning tools read: the household's members and accounts, the recurring
// payments, and one member's position in their pay cycle, from the same queries the app
// uses (as the signed-in user, so row level security keeps it to the household).

const round2 = (n: number) => Math.round(n * 100) / 100 + 0
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
const DAYS_PER_MONTH = 365.25 / 12
const EVERY_DAYS: Record<PayEvery, number> = { week: 7, fortnight: 14, month: DAYS_PER_MONTH }
/** Recurring payments are found over this many months for a member's position, so quarterly ones show. */
const POSITION_MONTHS = 6

// ── Members ──────────────────────────────────────────────────────────────────

/** The household's members, with who's signed in. */
export async function getMembers() {
  const [people, you] = await Promise.all([getPeople(), getUserId()])
  return { members: people.map((p) => ({ id: p.id, name: p.name, isYou: p.id === you })), you }
}

/** A member by id or name, or the signed-in person when none is given. */
export async function resolveMember(memberId?: string | null): Promise<Member & { isYou: boolean }> {
  const { members, you } = await getMembers()
  const want = memberId?.trim()
  const m = want
    ? members.find((x) => x.id === want || x.name.toLowerCase() === want.toLowerCase())
    : members.find((x) => x.id === you)
  if (!m) throw new Error(`No household member "${want}". Members: ${members.map((x) => `${x.name} (${x.id})`).join(", ")}`)
  return m
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type HouseholdAccount = {
  id: number
  name: string
  type: string
  institution: string | null
  balance: number
  holderId: string | null
  owner: string
  purpose: string | null
  /** set by hand; null when judged from its type */
  spendable: boolean | null
  archived: boolean
}

/** Every account with its balance, whose it is and what it's for. */
export async function householdAccounts(): Promise<HouseholdAccount[]> {
  const [accounts, holders, people, extra] = await Promise.all([
    getAccountsWithBalances(),
    getAccountHolders(),
    getPeople(),
    accountPurposes(),
  ])
  const nameOf = new Map(people.map((p) => [p.id, p.name]))
  return accounts.map((a) => {
    const holderId = holders.get(a.id) ?? null
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      institution: a.institution,
      balance: a.balance,
      holderId,
      owner: holderId === null ? "Joint" : (nameOf.get(holderId) ?? "Someone"),
      purpose: extra.get(a.id)?.purpose ?? null,
      spendable: extra.get(a.id)?.spendable ?? null,
      archived: a.archived,
    }
  })
}

async function accountPurposes() {
  const { data, error } = await (await getDb()).from("accounts").select("id, purpose, spendable")
  // before the migration that adds them, no account has a purpose yet
  if (error) return new Map<number, { purpose: string | null; spendable: boolean | null }>()
  return new Map(
    (data as { id: number; purpose: string | null; spendable: boolean | null }[]).map((r) => [r.id, r])
  )
}

// ── Recurring payments ───────────────────────────────────────────────────────

/** Every transaction from `months` back to today, in every account. */
export async function recentTransactions(months: number) {
  const today = todayLocal()
  return getMonthMoves(monthsBefore(today, months), addDays(today, 1)) as Promise<PaymentTx[]>
}

export async function loadRecurringPayments(months: number, txs?: PaymentTx[]) {
  const [accounts, people, rows] = await Promise.all([
    householdAccounts(),
    getPeople(),
    txs ? Promise.resolve(txs) : recentTransactions(months),
  ])
  const today = todayLocal()
  const payments = detectRecurringPayments({
    txs: rows,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, holderId: a.holderId })),
    names: new Map(people.map((p) => [p.id, p.name])),
    today,
    months,
  })
  return { today, payments, accounts, txs: rows }
}

/** Each expense category's average monthly spending over the transactions, transfers left out. */
export async function categorySpendMonthly(txs: PaymentTx[], months: number, accounts?: Set<number>) {
  const categories = await getCategories()
  const kind = new Map(categories.map((c) => [c.id, c.kind]))
  const paired = new Set(pairTransfers(txs).flatMap((p) => [p.outId, p.inId]))
  const out = new Map<number, number>()
  for (const t of txs) {
    if (t.categoryId === null || kind.get(t.categoryId) !== "expense" || paired.has(t.id)) continue
    if (accounts && !accounts.has(t.accountId)) continue
    out.set(t.categoryId, (out.get(t.categoryId) ?? 0) - t.amount)
  }
  for (const [k, v] of out) out.set(k, round2(v / months))
  return out
}

// ── Notes ────────────────────────────────────────────────────────────────────

export async function openNotes() {
  const { data, error } = await (await getDb())
    .from("cas_notes")
    .select("id, kind, content, dueDate:due_date, ref, subject, payerMemberId:payer_member_id, createdAt:created_at")
    .is("resolved_at", null)
    .order("id", { ascending: false })
    .limit(200)
  if (!error) return data as Pick<CasNote, "id" | "kind" | "content" | "dueDate" | "ref" | "subject" | "payerMemberId" | "createdAt">[]
  // before the migration adds subject and payer, read the notes without them
  const rows = await must<Pick<CasNote, "id" | "kind" | "content" | "dueDate" | "ref" | "createdAt">[]>(
    (await getDb())
      .from("cas_notes")
      .select("id, kind, content, dueDate:due_date, ref, createdAt:created_at")
      .is("resolved_at", null)
      .order("id", { ascending: false })
      .limit(200)
  )
  return rows.map((r) => ({ ...r, subject: null, payerMemberId: null }))
}

/** The standing rules about who pays for what, from the open decision notes. */
export async function standingRules() {
  const [notes, people] = await Promise.all([openNotes(), getPeople()])
  return payerRules(notes, people.map((p) => ({ id: p.id, name: p.name })))
}

// ── Plan against actual ──────────────────────────────────────────────────────

export async function loadPlanVsActual(months: number, plan?: Awaited<ReturnType<typeof loadBasis>>) {
  const { getCurrentPlan } = await import("@/lib/plan-data")
  const [current, { payments, accounts, txs }, rules, people] = await Promise.all([
    plan ? Promise.resolve(plan.plan) : getCurrentPlan(),
    loadRecurringPayments(months),
    standingRules(),
    getPeople(),
  ])
  if (!current) throw new Error("There's no plan yet: add plan items with upsert_plan_item.")
  const holder = new Map(accounts.map((a) => [a.id, a.holderId]))
  const nameOf = new Map(people.map((p) => [p.id, p.name]))
  return planVsActual({
    items: current.allocations,
    payments,
    categorySpend: await categorySpendMonthly(txs, months),
    rules,
    holderOf: (id) => holder.get(id) ?? null,
    nameOf: (id) => (id === null ? "Joint" : (nameOf.get(id) ?? "Someone")),
  })
}

// ── A member's pay cycle ─────────────────────────────────────────────────────

/** The pays still due into these accounts from today to `end`, on each regular income's cadence. */
function paysDueBefore(
  sources: { name: string; accountId: number | null; every: PayEvery | null; amount: number; nextDate: string | null }[],
  mine: Set<number>,
  today: string,
  end: string
): PayDue[] {
  const out: PayDue[] = []
  for (const s of sources) {
    if (s.accountId === null || !mine.has(s.accountId) || !s.every || !s.nextDate) continue
    for (let k = 0; k < 60; k++) {
      const date = addDays(s.nextDate, EVERY_DAYS[s.every] * k)
      if (date >= end) break
      if (date >= today) out.push({ accountId: s.accountId, date, amount: s.amount, name: s.name })
    }
  }
  return out
}

/**
 * Where a member stands in their pay cycle, with everything what_if needs to weigh a
 * purchase. `lines` replaces their short-term lines (to preview them). Throws when there's
 * no plan or no accounts marked as theirs.
 */
export async function loadMemberPosition(memberId?: string | null, opts: { lines?: Omit<ShortTermLine, "id" | "by">[] } = {}) {
  const member = await resolveMember(memberId)
  const holders = await getAccountHolders()
  const mine = [...holders].filter(([, h]) => h === member.id).map(([id]) => id)
  if (mine.length === 0) throw new Error(`No accounts are marked as ${member.name}'s: set the holder on the Accounts page.`)
  const basis = await loadBasis(mine)
  if (!basis) throw new Error("There's no plan to work the pay cycle from yet: add plan items with upsert_plan_item.")

  const today = basis.args.today
  const [saved, { payments, accounts, txs }, oneOffData] = await Promise.all([
    getShortTerm(member.id, basis.args.cycle.start),
    loadRecurringPayments(POSITION_MONTHS),
    getOneOffs(),
  ])
  const lines: ShortTermLine[] = opts.lines
    ? cleanLines(opts.lines.map((l) => ({ ...l, by: "claude" as const })), knownIds(basis))
    : (saved?.lines ?? [])
  const allocation = myAllocation({ ...basis.args, shortTerm: lines })
  const mineSet = new Set(mine)
  const balances = new Map(accounts.map((a) => [a.id, a.balance]))
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))
  const holderOf = new Map(accounts.map((a) => [a.id, a.holderId]))

  // payments a plan move or a line of this pay already counts, so they aren't bills as well
  const check = planVsActual({
    items: basis.plan.allocations,
    payments,
    categorySpend: new Map(),
    rules: [],
    holderOf: (id) => holderOf.get(id) ?? null,
    nameOf: () => "",
  })
  const moveIds = new Set(allocation.moves.map((m) => m.id))
  const covered = new Set<string>()
  for (const i of check.items) if (moveIds.has(i.planItemId)) i.matched.forEach((m) => covered.add(m.key))
  for (const l of lines) {
    for (const p of payments) {
      if (p.fromAccountId !== l.fromAccountId) continue
      if ((l.toAccountId !== null && p.toAccountId === l.toAccountId) || (l.match && p.matchKey === l.match)) covered.add(p.key)
    }
  }

  const cycle = basis.args.cycle
  const end = cycle.end > today ? cycle.end : addDays(today, 1)
  const position = cyclePosition({
    today,
    allocation,
    planItems: basis.plan.allocations,
    lines,
    mine,
    balances,
    accountName,
    payments,
    covered,
    paysDue: paysDueBefore(basis.args.sources, mineSet, today, end),
  })

  return {
    member,
    mine,
    mineSet,
    today,
    basis,
    saved,
    lines,
    allocation,
    position,
    payments,
    covered,
    accounts,
    balances,
    accountName,
    txs,
    oneOffs: oneOffData.oneOffs,
  }
}

export type MemberPosition = Awaited<ReturnType<typeof loadMemberPosition>>

/** Spending from these accounts over [start, end): expense and uncategorized money out, less transfers and recurring payments. */
function spendingBetween(
  txs: PaymentTx[],
  accounts: Set<number>,
  start: string,
  end: string,
  kind: Map<number, string>,
  recurring: Set<number>,
  paired: Set<number>
) {
  return round2(
    -sum(
      txs
        .filter(
          (t) =>
            accounts.has(t.accountId) &&
            t.date >= start &&
            t.date < end &&
            t.amount < 0 &&
            !paired.has(t.id) &&
            !recurring.has(t.id) &&
            (t.categoryId === null || kind.get(t.categoryId) === "expense")
        )
        .map((t) => t.amount)
    )
  )
}

/**
 * What a typical pay cycle ahead looks like for a member, and the three cycles behind this
 * one, for what_if: pays in, the plan's moves and the bills on their cadence, and what they
 * usually spend.
 */
export async function cycleModel(p: MemberPosition) {
  const { basis, mineSet, payments, covered, txs, today } = p
  const cycle = basis.args.cycle
  const days = cycle.pay ? Math.max(1, cycle.days) : Math.round(DAYS_PER_MONTH)
  const payEvery: PayEvery = cycle.pay?.every ?? "month"
  const perCycle = (every: PayEvery) => (cycle.pay && every === cycle.pay.every ? 1 : days / EVERY_DAYS[every])

  const income = round2(
    sum(
      basis.args.sources
        .filter((s) => s.accountId !== null && mineSet.has(s.accountId) && s.every)
        .map((s) => s.amount * perCycle(s.every!))
    )
  )
  const moves = round2(
    sum(
      basis.plan.allocations
        .filter((a) => a.fromAccountId !== null && mineSet.has(a.fromAccountId) && a.every && a.every !== "once" && (a.amount ?? 0) > 0)
        .map((a) => (a.amount ?? 0) * perCycle(a.every as PayEvery))
    )
  )
  const bills = round2(
    sum(
      payments
        .filter((x) => mineSet.has(x.fromAccountId) && !covered.has(x.key) && !(x.toAccountId !== null && mineSet.has(x.toAccountId)))
        .map((x) => (x.typicalAmount * days) / CADENCE[x.cadence].days)
    )
  )

  // usual spending: the three cycles before this one
  const categories = await getCategories()
  const kind = new Map(categories.map((c) => [c.id, c.kind as string]))
  const paired = new Set(pairTransfers(txs).flatMap((x) => [x.outId, x.inId]))
  const recurringIds = recurringTxIds(txs, payments)
  const back = [1, 2, 3].map((k) => {
    const start = addDays(cycle.start, -days * k)
    const end = addDays(cycle.start, -days * (k - 1))
    return { start, end, spent: spendingBetween(txs, mineSet, start, end, kind, recurringIds, paired) }
  })
  const spending = round2(sum(back.map((b) => b.spent)) / back.length)
  const spentSoFar = spendingBetween(txs, mineSet, cycle.start, addDays(today, 1), kind, recurringIds, paired)

  const model: CycleModel = { days, income, moves, bills, spending }
  return { model, payEvery, lastCycles: back, spentThisCycleSoFar: spentSoFar }
}

/** The transactions that make up the recurring payments, grouped as detectRecurringPayments groups them. */
function recurringTxIds(txs: PaymentTx[], payments: RecurringPayment[]) {
  const keys = new Set(payments.map((p) => p.key))
  const to = new Map(pairTransfers(txs).map((x) => [x.outId, x.toAccountId]))
  const out = new Set<number>()
  for (const t of txs) {
    if (t.amount >= 0) continue
    const matchKey = groupKey(t, to.get(t.id))
    if (keys.has(`${t.accountId}|${matchKey}`)) out.add(t.id)
  }
  return out
}

// ── Goals, buffers and cards ─────────────────────────────────────────────────

const GOAL_PURPOSES = new Set(["savings", "goal", "debt", "buffer", "one_off"])

/** The savings goals, debt paydown, buffers and one-offs a member's plan works towards (theirs or shared). */
export function memberGoals(p: MemberPosition): Goal[] {
  const { basis, position, mineSet, balances, accountName, accounts, member, today } = p
  const holder = new Map(accounts.map((a) => [a.id, a.holderId]))
  const move = new Map(position.moves.map((m) => [m.id, m]))
  const oneOff = new Map(p.oneOffs.map((o) => [o.id, o]))
  const goals: Goal[] = []
  const seenOneOffs = new Set<number>()
  for (const a of basis.plan.allocations) {
    if (!a.purpose || !GOAL_PURPOSES.has(a.purpose) || !a.every || a.every === "once") continue
    const payer = a.fromMemberId ?? (a.fromAccountId === null ? null : (holder.get(a.fromAccountId) ?? null))
    // another member's own goal is theirs to talk about
    if (payer !== null && payer !== member.id) continue
    const ratePerWeek = round2(((a.amount ?? 0) * PER_MONTH[a.every] * 12) / 52)
    const o = a.oneOffId !== null ? oneOff.get(a.oneOffId) : undefined
    const plan = o ? planOneOff(o, o.linked, today) : null
    if (o) seenOneOffs.add(o.id)
    const balance = a.accountId === null ? 0 : (balances.get(a.accountId) ?? 0)
    const m = move.get(a.id)
    goals.push({
      ref: `plan_item:${a.id}`,
      kind: "plan_item",
      name: a.title,
      purpose: a.purpose,
      planItemId: a.id,
      oneOffId: a.oneOffId,
      accountId: a.accountId,
      account: a.accountId === null ? null : (accountName.get(a.accountId) ?? null),
      fromAccountId: a.fromAccountId,
      target: o ? o.total : a.target,
      saved: round2(plan ? plan.held : a.purpose === "debt" ? 0 : Math.max(0, balance)),
      ratePerWeek,
      finishDate: o?.finishDate ?? a.endDate ?? null,
      leftThisPay: m ? m.left : 0,
      plannedThisPay: m ? m.planned : 0,
      shared: payer === null || (a.accountId !== null && holder.get(a.accountId) === null),
    })
  }
  for (const o of p.oneOffs) {
    if (seenOneOffs.has(o.id)) continue
    const plan = planOneOff(o, o.linked, today)
    if (plan.status === "paid") continue
    const weeks = Math.max(1, daysBetween(today, o.finishDate) / 7)
    goals.push({
      ref: `one_off:${o.id}`,
      kind: "one_off",
      name: o.name,
      purpose: "one_off",
      planItemId: null,
      oneOffId: o.id,
      accountId: o.accountId,
      account: accountName.get(o.accountId) ?? null,
      fromAccountId: null,
      target: o.total,
      saved: round2(plan.held),
      ratePerWeek: round2(plan.toPutIn / weeks),
      finishDate: o.finishDate,
      leftThisPay: 0,
      plannedThisPay: 0,
      shared: holder.get(o.accountId) === null || !mineSet.has(o.accountId),
    })
  }
  return goals
}

/** Buffers: the plan's buffer items' accounts, and accounts whose purpose says buffer or emergency. */
export function memberBuffers(p: MemberPosition): BufferPot[] {
  const { basis, accounts, mineSet } = p
  const rate = new Map<number, number>()
  for (const a of basis.plan.allocations) {
    if (a.purpose !== "buffer" || a.accountId === null || !a.every || a.every === "once") continue
    rate.set(a.accountId, (rate.get(a.accountId) ?? 0) + ((a.amount ?? 0) * PER_MONTH[a.every] * 12) / 52)
  }
  return accounts
    .filter((a) => !a.archived && (rate.has(a.id) || /buffer|emergency/i.test(`${a.purpose ?? ""} ${a.name}`)))
    .filter((a) => a.holderId === null || mineSet.has(a.id))
    .map((a) => ({
      accountId: a.id,
      name: a.name,
      balance: round2(a.balance),
      ratePerWeek: round2(rate.get(a.id) ?? 0),
      theirs: mineSet.has(a.id),
    }))
    .sort((a, b) => b.balance - a.balance)
}

/** Every credit card's position, from its balance and the household's pattern of paying it. */
export async function loadCardPositions(months = 3, loaded?: { payments: RecurringPayment[]; accounts: HouseholdAccount[]; txs: PaymentTx[] }) {
  const { payments, accounts, txs } = loaded ?? (await loadRecurringPayments(months))
  const from = monthsBefore(todayLocal(), months)
  const cards = accounts.filter((a) => a.type === "credit_card" && !a.archived)
  const spend = new Map<number, number>()
  const paid = new Map<number, number>()
  for (const t of txs) {
    if (t.date < from || !cards.some((c) => c.id === t.accountId)) continue
    const m = t.amount < 0 ? spend : paid
    m.set(t.accountId, (m.get(t.accountId) ?? 0) + Math.abs(t.amount) / months)
  }
  return cardPositions({
    cards: cards.map((c) => ({ id: c.id, name: c.name, balance: c.balance, owner: c.owner })),
    payments,
    spendByCard: spend,
    paidByCard: paid,
  })
}

// ── The working context for what_if ──────────────────────────────────────────

/** Whether an account's money is free to spend, and what it's earmarked for if not. */
export function earmarks(p: MemberPosition) {
  const { basis, accounts, today } = p
  const why = new Map<number, string[]>()
  const add = (id: number | null, text: string) => {
    if (id === null) return
    why.set(id, [...(why.get(id) ?? []), text])
  }
  for (const a of basis.plan.allocations) {
    if (a.purpose && GOAL_PURPOSES.has(a.purpose)) add(a.accountId, `${a.title} (${a.purpose})`)
  }
  for (const o of p.oneOffs) {
    const plan = planOneOff(o, o.linked, today)
    if (plan.status !== "paid" && plan.held > 0) add(o.accountId, `${o.name}: ${plan.held.toFixed(2)} held`)
  }
  return accounts
    .filter((a) => !a.archived)
    .map((a) => {
      const earmarkedFor = why.get(a.id) ?? []
      const spendable = a.spendable ?? (["checking", "cash"].includes(a.type) && earmarkedFor.length === 0 && a.balance > 0)
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        owner: a.owner,
        purpose: a.purpose,
        balance: round2(a.balance),
        spendable,
        earmarkedFor,
      }
    })
}

/** This cycle's share of each budget against spending from the member's and joint accounts, with the three cycles before. */
export async function cycleBudgets(p: MemberPosition, model: Awaited<ReturnType<typeof cycleModel>>) {
  const { today, position, mineSet, accounts, basis, txs } = p
  const joint = new Set(accounts.filter((a) => a.holderId === null).map((a) => a.id))
  const ours = (id: number) => mineSet.has(id) || joint.has(id)
  const categories = await getCategories()
  const kind = new Map(categories.map((c) => [c.id, c.kind]))
  const name = new Map(categories.map((c) => [c.id, c.name]))
  const paired = new Set(pairTransfers(txs).flatMap((x) => [x.outId, x.inId]))
  const spendByCategory = (start: string, stop: string) => {
    const out = new Map<number, number>()
    for (const t of txs) {
      if (!ours(t.accountId) || t.date < start || t.date >= stop || paired.has(t.id)) continue
      if (t.categoryId === null || kind.get(t.categoryId) !== "expense") continue
      out.set(t.categoryId, (out.get(t.categoryId) ?? 0) - t.amount)
    }
    return out
  }
  const days = model.model.days
  const nowSpend = spendByCategory(position.cycle.start, addDays(today, 1))
  const past = model.lastCycles.map((c) => spendByCategory(c.start, c.end))
  return basis.inputs.categories
    .filter((c) => c.categoryId !== null && (c.budget !== null || nowSpend.has(c.categoryId!)))
    .map((c) => {
      const id = c.categoryId!
      const cycleBudget = c.budget === null ? null : round2((c.budget * days) / DAYS_PER_MONTH)
      const spent = round2(nowSpend.get(id) ?? 0)
      return {
        categoryId: id,
        name: name.get(id) ?? c.name,
        monthlyBudget: c.budget,
        cycleBudget,
        spentThisCycle: spent,
        remainingThisCycle: cycleBudget === null ? null : round2(cycleBudget - spent),
        lastThreeCycles: past.map((m) => round2(m.get(id) ?? 0)),
      }
    })
    .filter((b) => b.cycleBudget !== null || b.spentThisCycle > 0 || b.lastThreeCycles.some((x) => x > 0))
}

/**
 * Everything around a what_if's verdict, for Claude to reason with: accounts, what's due,
 * budgets, the card, the other member's shared moves, recent irregular spending, and the
 * assumptions under it all, each with how sure it is. Only the member's own and joint
 * accounts' spending is read; the other member's appears only where it's shared.
 */
export async function whatIfContext(p: MemberPosition, model: Awaited<ReturnType<typeof cycleModel>>) {
  const { today, position, payments, mineSet, accounts, basis, member, txs } = p
  const joint = new Set(accounts.filter((a) => a.holderId === null).map((a) => a.id))
  const ours = (id: number) => mineSet.has(id) || joint.has(id)
  const end = position.cycle.end > today ? position.cycle.end : addDays(today, 1)
  const in90 = addDays(today, 90)

  const due = (to: string) => [
    ...payments
      // moves between their own accounts aren't money going anywhere
      .filter((x) => ours(x.fromAccountId) && !(x.toAccountId !== null && mineSet.has(x.fromAccountId) && mineSet.has(x.toAccountId)))
      .flatMap((x) =>
        datesBetween(x, today, to).map((date) => ({
          date,
          name: x.name,
          kind: "recurring" as const,
          amount: x.typicalAmount,
          from: x.fromAccount,
          owner: x.owner,
          confidence: x.confidence,
        }))
      ),
    ...p.oneOffs.flatMap((o) =>
      planOneOff(o, o.linked, today)
        .moves.filter((m) => m.kind === "out" && m.date >= today && m.date < to)
        .map((m) => ({
          date: m.date,
          name: o.name,
          kind: "one_off" as const,
          amount: m.amount,
          from: p.accountName.get(o.accountId) ?? null,
          owner: accounts.find((a) => a.id === o.accountId)?.owner ?? null,
          confidence: "high",
        }))
    ),
  ].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)

  const budgets = await cycleBudgets(p, model)
  const categories = await getCategories()
  const kind = new Map(categories.map((c) => [c.id, c.kind]))
  const name = new Map(categories.map((c) => [c.id, c.name]))
  const paired = new Set(pairTransfers(txs).flatMap((x) => [x.outId, x.inId]))
  const days = model.model.days

  // the other member, for what's shared: their cycle and their moves into joint accounts
  const { members } = await getMembers()
  const others = members.filter((m) => m.id !== member.id)
  const otherMembers = []
  for (const o of others) {
    try {
      const op = await loadMemberPosition(o.id)
      otherMembers.push({
        member: o.name,
        cycle: { start: op.position.cycle.start, nextPayday: op.position.cycle.end, late: op.position.cycle.late },
        payInSoFar: op.position.pay.soFar,
        payStillDue: op.position.pay.stillDue,
        sharedMoves: op.position.moves
          .filter((m) => {
            const to = op.basis.plan.allocations.find((a) => a.id === m.id)?.accountId ?? null
            return to !== null && joint.has(to)
          })
          .map((m) => ({ title: m.title, to: m.to, planned: m.planned, done: m.done, left: m.left, status: m.status })),
      })
    } catch {
      // no accounts marked as theirs, or no plan: nothing shared to show
    }
  }

  // irregular spending in the last 60 days: big money out that isn't a recurring payment or a transfer
  const recurringIds = recurringTxIds(txs, payments)
  const since = addDays(today, -60)
  const irregular = txs
    .filter(
      (t) =>
        ours(t.accountId) &&
        t.date >= since &&
        t.amount <= -100 &&
        !paired.has(t.id) &&
        !recurringIds.has(t.id) &&
        (t.categoryId === null || kind.get(t.categoryId) === "expense")
    )
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 15)
    .map((t) => ({
      date: t.date,
      description: t.description,
      amount: round2(-t.amount),
      account: p.accountName.get(t.accountId) ?? null,
      category: t.categoryId === null ? "Uncategorized" : (name.get(t.categoryId) ?? null),
    }))

  // what it all rests on
  const payAssumptions = basis.inputs.incomeSources
    .filter((s) => s.accountId !== null && mineSet.has(s.accountId))
    .map((s) => ({
      what: `Pay: ${s.name}`,
      value: s.amount,
      cadence: s.cadence,
      nextDate: s.nextDate,
      confidence: s.cadence === "Irregular" ? "low" : s.nextDate && s.nextDate < today ? "medium" : "high",
      why:
        s.cadence === "Irregular"
          ? "Irregular income, averaged"
          : s.nextDate && s.nextDate < today
            ? "It's past its expected date"
            : `Regular ${s.cadence.toLowerCase()} pay, latest amount`,
    }))
  const billAssumptions = payments
    .filter((x) => mineSet.has(x.fromAccountId) && !p.covered.has(x.key))
    .map((x) => ({
      what: `Recurring: ${x.name} from ${x.fromAccount}`,
      value: x.typicalAmount,
      cadence: x.cadence,
      nextDate: x.nextExpected,
      confidence: x.confidence,
      why: `${x.count} payments seen${x.amountVaries ? `, ${x.minAmount.toFixed(2)}–${x.maxAmount.toFixed(2)}` : ", steady"}`,
    }))
  const spends = model.lastCycles.map((c) => c.spent)
  const spread = spends.length ? Math.max(...spends) - Math.min(...spends) : 0
  const spendAssumption = {
    what: "Usual spending per cycle from their accounts (not bills or moves)",
    value: model.model.spending,
    cadence: `per ${days}-day cycle`,
    nextDate: null,
    confidence: spread > model.model.spending * 0.5 ? "low" : spread > model.model.spending * 0.25 ? "medium" : "high",
    why: `Average of the last three cycles: ${spends.map((x) => x.toFixed(2)).join(", ")}`,
  }

  return {
    accounts: earmarks(p),
    dueBeforePayday: due(end),
    dueNext90Days: due(in90),
    budgets,
    otherMembers,
    recentIrregularSpending: irregular,
    assumptions: [...payAssumptions, ...billAssumptions, spendAssumption],
  }
}
