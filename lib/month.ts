import "server-only"

import { monthOf, weekOf } from "@/lib/budget-tracking"
import { monthFigures } from "@/lib/month-figures"
import { planOneOff } from "@/lib/one-offs"
import { loadPlanInputs, type PlanInputs } from "@/lib/plan-inputs"
import { getCategories, getOneOffs, getSpendTransactions } from "@/lib/queries"
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
