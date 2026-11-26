import "server-only"

import { connection } from "next/server"

import { COLUMNS, getDb, must } from "@/lib/db"
import type { Plan, PlanItem } from "@/lib/db/schema"

/**
 * The current plan (the newest) and its items in order, or null before there's one. Removed
 * items are left out unless `withRemoved`, for their history.
 */
export async function getCurrentPlan(opts: { withRemoved?: boolean } = {}) {
  await connection()
  const db = await getDb()
  const [plan] = await must<Plan[]>(
    db.from("plans").select(COLUMNS.plans).order("id", { ascending: false }).limit(1)
  )
  if (!plan) return null
  let query = db.from("plan_items").select(COLUMNS.planItems).eq("plan_id", plan.id)
  if (!opts.withRemoved) query = query.is("removed_at", null)
  const items = (await must<PlanItem[]>(query.order("kind").order("position"))).map((i) => ({
    ...i,
    target: i.target === null ? null : Number(i.target),
    matchKeys: i.matchKeys ?? [],
  }))
  return {
    plan,
    allocations: items
      .filter((i) => i.kind === "allocation")
      .map((i) => ({ ...i, amount: i.amount === null ? null : Number(i.amount) })),
    actions: items.filter((i) => i.kind === "action"),
  }
}

export type CurrentPlan = NonNullable<Awaited<ReturnType<typeof getCurrentPlan>>>
