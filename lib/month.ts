import "server-only"

import { addDays, format, parseISO } from "date-fns"

import { monthOf, weekOf } from "@/lib/budget-tracking"
import { monthFigures } from "@/lib/month-figures"
import { myAllocation, payCycle, type PayEvery } from "@/lib/my-allocation"
import { cycleMoves, shortTermFingerprint } from "@/lib/short-term"
import { getShortTerm } from "@/lib/short-term-data"
import { planOneOff } from "@/lib/one-offs"
import { loadPlanInputs, type PlanInputs } from "@/lib/plan-inputs"
import type { CurrentPlan } from "@/lib/plan-data"
import { getCategories, getMonthMoves, getOneOffs, getSpendTransactions } from "@/lib/queries"
import { CADENCE_DAYS, CADENCE_LABELS, type Cadence } from "@/lib/recurring"
import { todayLocal } from "@/supabase/functions/_shared/akahu"
import { PAY_MIN } from "@/supabase/functions/_shared/nudges"

/**
 * This month for Home and the briefing (see lib/month-figures.ts): money in and out, where
 * it's heading, and every budget broken down by merchant. Pass `inputs` when they're
 * already loaded.
 */
export async function loadMonthFigures(opts: { mine?: number[] | null; inputs?: PlanInputs | null } = {}) {
  const today = todayLocal()
  const month = monthOf(today)
  const week = weekOf(today)
  const from = week.start < month.start ? week.start : month.start
  const [inputs, categories, txs, { oneOffs }] = await Promise.all([
    opts.inputs !== undefined ? opts.inputs : loadPlanInputs(),
    getCategories(),
    getSpendTransactions(from, month.end),
    getOneOffs(),
  ])
  return monthFigures({
    today,
    txs,
    categories,
    projection: inputs?.categories ?? [],
    paysDue: inputs?.paysDue ?? [],
    billsDue: inputs?.billsDue ?? [],
    oneOffs: oneOffs.map((o) => ({
      id: o.id,
      name: o.name,
      outThisMonth: planOneOff(o, o.linked, today)
        .moves.filter((m) => m.kind === "out" && m.date < month.end)
        .reduce((s, m) => s + m.amount, 0),
    })),
    mine: opts.mine ?? null,
  })
}

const PAY_EVERY: Record<string, PayEvery> = { Weekly: "week", Fortnightly: "fortnight", Monthly: "month" }
const CADENCE_OF = new Map(Object.entries(CADENCE_LABELS).map(([c, label]) => [label, c as Cadence]))

/**
 * What a pay cycle's allocation is worked out from: the cycle itself, its transactions in
 * every account, and the plan inputs it needs. Null without a plan or accounts of yours.
 */
export async function loadAllocationBasis(opts: { mine: number[]; plan: CurrentPlan | null; inputs: PlanInputs | null }) {
  if (!opts.plan || !opts.inputs || opts.mine.length === 0) return null
  const today = todayLocal()
  const sources = opts.inputs.incomeSources.map((s) => ({ ...s, every: PAY_EVERY[s.cadence] ?? null }))
  const cycle = payCycle({ today, mine: opts.mine, sources })
  // through tomorrow, so a late pay's cycle still takes in today
  const through = cycle.end > today ? cycle.end : format(addDays(parseISO(today), 1), "yyyy-MM-dd")
  const [txs, categories] = await Promise.all([getMonthMoves(cycle.start, through), getCategories()])
  // each account's main pay: its largest regular income
  const payEvery = new Map<number, PayEvery>()
  for (const s of [...sources].sort((a, b) => b.monthly - a.monthly)) {
    if (s.accountId !== null && s.every && !payEvery.has(s.accountId)) payEvery.set(s.accountId, s.every)
  }
  const args = {
    today,
    cycle,
    mine: opts.mine,
    allocations: opts.plan.allocations,
    txs,
    categories,
    sources,
    bills: opts.inputs.bills.flatMap((b) => {
      const cadence = CADENCE_OF.get(b.cadence)
      return cadence ? [{ ...b, days: CADENCE_DAYS[cadence].days }] : []
    }),
    payEvery,
    accountName: new Map(opts.inputs.accounts.map((a) => [a.id, a.name])),
  }
  const transferCategories = new Set(categories.filter((c) => c.kind === "transfer").map((c) => c.id))
  const income = new Set(categories.filter((c) => c.kind === "income").map((c) => c.id))
  const mineSet = new Set(opts.mine)
  const moves = cycleMoves({ txs, mine: opts.mine, transferCategories, start: cycle.start, through })
  const pays = txs
    .filter((t) => mineSet.has(t.accountId) && t.categoryId !== null && income.has(t.categoryId) && t.amount >= PAY_MIN)
    .map((t) => t.id)
  return {
    args,
    plan: opts.plan,
    inputs: opts.inputs,
    moves,
    fingerprint: shortTermFingerprint({ cycleStart: cycle.start, planId: opts.plan.plan.id, pays, moves }),
  }
}

export type AllocationBasis = NonNullable<Awaited<ReturnType<typeof loadAllocationBasis>>>

/**
 * What the plan and Cas's short-term allocation do with your pay this pay cycle, and how
 * it's going (see lib/my-allocation.ts), for Home's My view. Null without a plan or
 * accounts of yours. shortTerm.stale says no one has looked since a sync brought in
 * something new.
 */
export async function loadMyAllocation(opts: {
  memberId: string
  mine: number[]
  plan: CurrentPlan | null
  inputs: PlanInputs | null
}) {
  const basis = await loadAllocationBasis(opts)
  if (!basis) return null
  const saved = await getShortTerm(opts.memberId, basis.args.cycle.start)
  return {
    ...myAllocation({ ...basis.args, shortTerm: saved?.lines ?? [] }),
    shortTerm: {
      summary: saved?.summary ?? null,
      madeBy: saved?.madeBy ?? null,
      updatedAt: saved?.updatedAt ?? null,
      stale: saved?.fingerprint !== basis.fingerprint,
    },
  }
}

export type MyAllocationView = NonNullable<Awaited<ReturnType<typeof loadMyAllocation>>>
