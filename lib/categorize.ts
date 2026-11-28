import "server-only"

import { COLUMNS, DbError, getDb, must, selectAll, type Db } from "@/lib/db"
import type { Rule } from "@/lib/db/schema"
import { buildMatcher } from "@/lib/rules"

/** Rows the user hasn't claimed: auto-categorized or never categorized (a PostgREST or filter). */
const NOT_MANUAL = "category_source.is.null,category_source.neq.manual"

/** Every rule, for buildMatcher. */
export function getAllRules(db: Db) {
  return selectAll<Rule>((from, to) =>
    db.from("rules").select(COLUMNS.rules).order("id").range(from, to)
  )
}

/**
 * Categorize uncategorized transactions with the rule table.
 * Rows you explicitly left uncategorized are skipped.
 */
export async function applyRulesToUncategorized(db?: Db) {
  db ??= await getDb()
  const match = buildMatcher(await getAllRules(db))
  const rows = await selectAll<{ id: number; description: string }>((from, to) =>
    db
      .from("transactions")
      .select("id, description")
      .is("category_id", null)
      .or(NOT_MANUAL)
      .order("id")
      .range(from, to)
  )

  // Group identical outcomes so we issue one UPDATE per (rule, confidence).
  const groups = new Map<string, { ids: number[]; m: NonNullable<ReturnType<typeof match>> }>()
  for (const r of rows) {
    const m = match(r.description)
    if (!m) continue
    const k = `${m.ruleId}|${m.confidence}`
    const g = groups.get(k) ?? { ids: [], m }
    g.ids.push(r.id)
    groups.set(k, g)
  }
  let n = 0
  for (const { ids, m } of groups.values()) {
    n += await setCategories(db, ids, {
      categoryId: m.categoryId,
      ruleId: m.ruleId,
      source: m.source,
      confidence: m.confidence,
    })
  }
  return n
}

/** Categorize the given transactions that are still uncategorized; returns how many changed. */
export function setCategories(
  db: Db,
  ids: number[],
  c: { categoryId: number; ruleId: number; source: "rule" | "ai"; confidence: number }
) {
  return must<number>(
    db.rpc("set_transaction_categories", {
      p_ids: ids,
      p_category_id: c.categoryId,
      p_rule_id: c.ruleId,
      p_source: c.source,
      p_confidence: c.confidence,
    })
  )
}

/** Create or update the merchant rule for a key; returns its id. */
export async function upsertMerchantRule(
  db: Db,
  key: string,
  values: {
    categoryId: number
    source: "ai" | "learned"
    confidence: number
    reason?: string | null
  }
) {
  const row = {
    category_id: values.categoryId,
    source: values.source,
    confidence: values.confidence,
    ...(values.reason !== undefined && { reason: values.reason }),
  }
  const [existing] = await must<{ id: number }[]>(
    db.from("rules").select("id").eq("kind", "merchant").eq("pattern", key).limit(1)
  )
  if (existing) {
    await must(db.from("rules").update(row).eq("id", existing.id))
    return existing.id
  }
  const created = await must<{ id: number }>(
    db
      .from("rules")
      .insert({ ...row, pattern: key, kind: "merchant" })
      .select("id")
      .single()
  )
  return created.id
}

/**
 * Move every auto-categorized transaction of a rule to its current category.
 * Transactions you set by hand are left alone.
 */
export async function syncRuleTransactions(db: Db, ruleId: number) {
  const [rule] = await must<Pick<Rule, "categoryId" | "source" | "confidence">[]>(
    db
      .from("rules")
      .select("categoryId:category_id, source, confidence")
      .eq("id", ruleId)
  )
  if (!rule) return 0
  const { count, error } = await db
    .from("transactions")
    .update(
      {
        category_id: rule.categoryId,
        category_source: rule.source === "ai" ? "ai" : "rule",
        category_confidence: rule.confidence,
      },
      { count: "exact" }
    )
    .eq("rule_id", ruleId)
    .or(NOT_MANUAL)
  if (error) throw new DbError(error)
  return count ?? 0
}

export type AutoCategorizeResult = {
  /** Categorized by the rules. */
  byRules: number
  /** Still uncategorized afterwards: the review queue, and the sync's to-dos. */
  remaining: number
}

/**
 * Apply the rules (exact merchant, contains, fuzzy) to everything uncategorized. What they
 * don't take waits in the review queue for Claude and the household to categorize.
 */
export async function autoCategorize(): Promise<AutoCategorizeResult> {
  const db = await getDb()
  const byRules = await applyRulesToUncategorized(db)
  const { count, error } = await db
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .is("category_id", null)
    .or(NOT_MANUAL)
  if (error) throw new DbError(error)
  return { byRules, remaining: count ?? 0 }
}
