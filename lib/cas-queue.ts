import "server-only"

import { applyRulesToUncategorized, syncRuleTransactions, upsertMerchantRule } from "@/lib/categorize"
import { getDb, must, type Db } from "@/lib/db"
import { syncUncategorizedTodos } from "@/lib/uncategorized-todos"
import { digestQueue, merchantName } from "@/supabase/functions/_shared/cas-queue"

// The corrections waiting for Cas (cas_queue, see its migration): read for Home and the
// briefing, and taken in on demand here (Update Cas). The akahu-sync edge function takes them
// in each morning the same way (supabase/functions/akahu-sync/cas-queue.ts).

const QUEUE_COLUMNS =
  "id, transactionId:transaction_id, description, merchantKey:merchant_key, amount, txDate:tx_date, fromCategoryId:from_category_id, fromOneOffId:from_one_off_id, toCategoryId:to_category_id, toOneOffId:to_one_off_id, remember, createdAt:created_at, processedAt:processed_at, outcome"

export type QueueRow = {
  id: number
  transactionId: number
  description: string
  merchantKey: string
  amount: number
  txDate: string
  fromCategoryId: number | null
  fromOneOffId: number | null
  toCategoryId: number | null
  toOneOffId: number | null
  remember: boolean
  createdAt: string
  processedAt: string | null
  outcome: string | null
}

/** Processed corrections stay in the briefing for this long, so Cas knows what was fixed. */
const RECENT_DAYS = 30

async function names(db: Db) {
  const [categories, oneOffs] = await Promise.all([
    must<{ id: number; name: string }[]>(db.from("categories").select("id, name")),
    must<{ id: number; name: string }[]>(db.from("one_offs").select("id, name")),
  ])
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const one = new Map(oneOffs.map((o) => [o.id, o.name]))
  return {
    category: (id: number | null) => (id === null ? "Uncategorized" : (cat.get(id) ?? "a removed category")),
    oneOff: (id: number) => one.get(id) ?? "a removed one-off payment",
  }
}

/** The corrections still waiting for Cas, oldest first. */
export async function getPendingCorrections(db?: Db) {
  db ??= await getDb()
  return must<QueueRow[]>(
    db.from("cas_queue").select(QUEUE_COLUMNS).is("processed_at", null).order("created_at").order("id")
  )
}

/** The waiting corrections and the recently processed ones, in words, for Cas. */
export async function getCorrections(db?: Db) {
  db ??= await getDb()
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString()
  const [pending, done, n] = await Promise.all([
    getPendingCorrections(db),
    must<QueueRow[]>(
      db
        .from("cas_queue")
        .select(QUEUE_COLUMNS)
        .gte("processed_at", since)
        .order("processed_at", { ascending: false })
        .limit(50)
    ),
    names(db),
  ])
  const describe = (r: QueueRow) => ({
    id: r.id,
    transactionId: r.transactionId,
    date: r.txDate,
    description: r.description,
    merchant: merchantName(r.merchantKey),
    amount: Number(r.amount),
    from: r.fromOneOffId !== null ? `one-off: ${n.oneOff(r.fromOneOffId)}` : n.category(r.fromCategoryId),
    to: r.toOneOffId !== null ? `one-off: ${n.oneOff(r.toOneOffId)}` : n.category(r.toCategoryId),
    rememberForMerchant: r.remember,
    movedAt: r.createdAt,
    ...(r.processedAt && { processedAt: r.processedAt, outcome: r.outcome }),
  })
  return { waiting: pending.map(describe), recentlyTakenIn: done.map(describe) }
}

export type CasUpdate = { processed: number; rules: number; recategorized: number }

/**
 * Cas takes in every waiting correction now: remembered moves become merchant rules (moving
 * that merchant's other auto-categorized transactions and any uncategorized ones with it),
 * and each row is marked with what was done.
 */
export async function processCasQueue(db?: Db): Promise<CasUpdate> {
  db ??= await getDb()
  const pending = await getPendingCorrections(db)
  if (pending.length === 0) return { processed: 0, rules: 0, recategorized: 0 }

  const digest = digestQueue(pending, await names(db))
  let recategorized = 0
  for (const r of digest.rules) {
    const ruleId = await upsertMerchantRule(db, r.merchantKey, {
      categoryId: r.categoryId,
      source: "learned",
      confidence: 100,
    })
    recategorized += await syncRuleTransactions(db, ruleId)
  }
  if (digest.rules.length > 0) {
    recategorized += await applyRulesToUncategorized(db)
    await syncUncategorizedTodos(db).catch((err) => console.error("uncategorized to-dos", err))
  }

  const at = new Date().toISOString()
  await Promise.all(
    digest.outcomes.map((o) =>
      must(db.from("cas_queue").update({ processed_at: at, outcome: o.outcome }).eq("id", o.id))
    )
  )
  return { processed: pending.length, rules: digest.rules.length, recategorized }
}
