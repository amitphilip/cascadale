import "server-only"

import { must, selectAll, type Db } from "@/lib/db"
import { daysBefore, todayLocal } from "@/supabase/functions/_shared/akahu"
import { pairTransfers } from "@/supabase/functions/_shared/transfers"

/** How far back new syncs and imports are paired. */
const PAIR_DAYS = 120

type Row = {
  id: number
  accountId: number
  date: string
  amount: number
  description: string
  categoryId: number | null
  categorySource: string | null
  categoryKind: string | null
}

/**
 * Categorize both sides of transfers between your own accounts as Transfer, with full
 * confidence: money out of one account matched to the same amount into another within a
 * few days. Only uncategorized money is touched; anything you categorized yourself, or
 * that a rule put in an income or expense category, stays as it is. The akahu-sync edge
 * function does the same after each scheduled sync.
 */
export async function categorizeInternalTransfers(db: Db, days = PAIR_DAYS) {
  const since = daysBefore(todayLocal(), days).slice(0, 10)
  const rows = await selectAll<Row>((from, to) =>
    db
      .from("transactions")
      .select(
        "id, accountId:account_id, date, amount, description, categoryId:category_id, categorySource:category_source, ...categories(categoryKind:kind)"
      )
      .gte("date", since)
      .order("id")
      .range(from, to)
  )
  const candidates = rows
    .map((r) => ({ ...r, amount: Number(r.amount) }))
    .filter(
      (r) =>
        r.categoryKind === "transfer" ||
        (r.categoryId === null && r.categorySource !== "manual")
    )
  const pairs = pairTransfers(candidates)
  const byId = new Map(candidates.map((r) => [r.id, r]))
  const ids = pairs
    .flatMap((p) => [p.outId, p.inId])
    .filter((id) => byId.get(id)!.categoryId === null)
  if (!ids.length) return { pairs: pairs.length, categorized: 0 }

  const categoryId = await transferCategory(db)
  const updated = await must<{ id: number }[]>(
    db
      .from("transactions")
      .update({
        category_id: categoryId,
        category_source: "rule",
        category_confidence: 100,
        rule_id: null,
      })
      .in("id", ids)
      .is("category_id", null)
      .select("id")
  )
  return { pairs: pairs.length, categorized: updated.length }
}

/** The Transfer category, or the first transfer-kind one, created if there's none. */
async function transferCategory(db: Db) {
  const cats = await must<{ id: number; name: string }[]>(
    db.from("categories").select("id, name").eq("kind", "transfer").order("id")
  )
  const found = cats.find((c) => c.name.toLowerCase() === "transfer") ?? cats[0]
  if (found) return found.id
  return (
    await must<{ id: number }>(
      db.from("categories").insert({ name: "Transfer", kind: "transfer" }).select("id").single()
    )
  ).id
}
