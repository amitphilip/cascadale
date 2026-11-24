import "server-only"

import { monthOf, weekOf } from "@/lib/budget-tracking"
import { monthFigures } from "@/lib/month-figures"
import { myAllocation, type PayEvery } from "@/lib/my-allocation"
import { planOneOff } from "@/lib/one-offs"
import { loadPlanInputs, type PlanInputs } from "@/lib/plan-inputs"
import type { CurrentPlan } from "@/lib/plan-data"
import { getCategories, getMonthMoves, getOneOffs, getSpendTransactions } from "@/lib/queries"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

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

/**
 * What the plan does with your pay this month and how it's going (see lib/my-allocation.ts),
 * for Home's My view. Null without a plan or accounts of yours.
 */
export async function loadMyAllocation(opts: { mine: number[]; plan: CurrentPlan | null; inputs: PlanInputs | null }) {
  if (!opts.plan || !opts.inputs || opts.mine.length === 0) return null
  const today = todayLocal()
  const month = monthOf(today)
  const [txs, categories] = await Promise.all([getMonthMoves(month.start, month.end), getCategories()])
  // each account's main pay: its largest regular income
  const payEvery = new Map<number, PayEvery>()
  for (const s of [...opts.inputs.incomeSources].sort((a, b) => b.monthly - a.monthly)) {
    const every = PAY_EVERY[s.cadence]
    if (s.accountId !== null && every && !payEvery.has(s.accountId)) payEvery.set(s.accountId, every)
  }
  return myAllocation({
    today,
    mine: opts.mine,
    allocations: opts.plan.allocations,
    txs,
    categories,
    paysDue: opts.inputs.paysDue,
    payEvery,
    accountName: new Map(opts.inputs.accounts.map((a) => [a.id, a.name])),
  })
}
