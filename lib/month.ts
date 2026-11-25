import "server-only"

import { addDays, format, parseISO } from "date-fns"

import { monthOf, weekOf } from "@/lib/budget-tracking"
import { monthFigures } from "@/lib/month-figures"
import { myAllocation, payCycle, type PayEvery } from "@/lib/my-allocation"
import { planOneOff } from "@/lib/one-offs"
import { loadPlanInputs, type PlanInputs } from "@/lib/plan-inputs"
import type { CurrentPlan } from "@/lib/plan-data"
import { getCategories, getMonthMoves, getOneOffs, getSpendTransactions } from "@/lib/queries"
import { CADENCE_DAYS, CADENCE_LABELS, type Cadence } from "@/lib/recurring"
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
const CADENCE_OF = new Map(Object.entries(CADENCE_LABELS).map(([c, label]) => [label, c as Cadence]))

/**
 * What the plan does with your pay this pay cycle and how it's going (see
 * lib/my-allocation.ts), for Home's My view. Null without a plan or accounts of yours.
 */
export async function loadMyAllocation(opts: { mine: number[]; plan: CurrentPlan | null; inputs: PlanInputs | null }) {
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
  return myAllocation({
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
  })
}
