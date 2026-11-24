// Cas's morning run: the first sync from CAS_QUEUE_HOUR each day takes in the corrections
// queued before today (see ../_shared/cas-queue.ts for what it does with them). Corrections
// made today wait for tomorrow's run, or for Update Cas in the app (lib/cas-queue.ts), which
// does the same as the signed-in user.
//
// It acts with the service role, so every query filters by user_id itself.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0"

import { localDate, todayLocal } from "../_shared/akahu.ts"
import { CAS_QUEUE_HOUR, digestQueue } from "../_shared/cas-queue.ts"
import { merchantKey } from "../_shared/rules.ts"

type Db = SupabaseClient

async function must<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data as T
}

function localHour(now = new Date()) {
  const hour = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", hourCycle: "h23" })
    .formatToParts(now)
    .find((p) => p.type === "hour")?.value
  return Number(hour)
}

type Pending = {
  id: number
  merchantKey: string
  toCategoryId: number | null
  toOneOffId: number | null
  remember: boolean
  createdAt: string
}

/** Takes in yesterday's and older corrections; returns how many, or 0 before the hour. */
export async function runCasQueue(db: Db, userId: string) {
  if (localHour() < CAS_QUEUE_HOUR) return 0
  const today = todayLocal()
  const pending = (
    await must<Pending[]>(
      db
        .from("cas_queue")
        .select("id, merchantKey:merchant_key, toCategoryId:to_category_id, toOneOffId:to_one_off_id, remember, createdAt:created_at")
        .eq("user_id", userId)
        .is("processed_at", null)
        .order("created_at")
        .order("id")
    )
  ).filter((p) => localDate(p.createdAt) < today)
  if (pending.length === 0) return 0

  const [categories, oneOffs] = await Promise.all([
    must<{ id: number; name: string }[]>(db.from("categories").select("id, name").eq("user_id", userId)),
    must<{ id: number; name: string }[]>(db.from("one_offs").select("id, name").eq("user_id", userId)),
  ])
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const one = new Map(oneOffs.map((o) => [o.id, o.name]))
  const digest = digestQueue(pending, {
    category: (id) => cat.get(id) ?? "a removed category",
    oneOff: (id) => one.get(id) ?? "a removed one-off payment",
  })

  if (digest.rules.length > 0) {
    // the merchants' uncategorized transactions (not ones left uncategorized on purpose)
    const uncategorized = await must<{ id: number; description: string }[]>(
      db
        .from("transactions")
        .select("id, description")
        .eq("user_id", userId)
        .is("category_id", null)
        .or("category_source.is.null,category_source.neq.manual")
        .limit(5000)
    )
    for (const r of digest.rules) {
      const row = { category_id: r.categoryId, source: "learned", confidence: 100 }
      const [existing] = await must<{ id: number }[]>(
        db.from("rules").select("id").eq("user_id", userId).eq("kind", "merchant").eq("pattern", r.merchantKey).limit(1)
      )
      const ruleId = existing
        ? (await must(db.from("rules").update(row).eq("id", existing.id)), existing.id)
        : (
            await must<{ id: number }>(
              db
                .from("rules")
                .insert({ ...row, user_id: userId, kind: "merchant", pattern: r.merchantKey })
                .select("id")
                .single()
            )
          ).id
      const tagged = { category_id: r.categoryId, category_source: "rule", category_confidence: 100 }
      // the rule's own auto-categorized transactions follow it; ones set by hand stay
      await must(
        db
          .from("transactions")
          .update(tagged)
          .eq("user_id", userId)
          .eq("rule_id", ruleId)
          .or("category_source.is.null,category_source.neq.manual")
      )
      const ids = uncategorized.filter((t) => merchantKey(t.description) === r.merchantKey).map((t) => t.id)
      if (ids.length > 0) {
        await must(db.from("transactions").update({ ...tagged, rule_id: ruleId }).in("id", ids))
      }
    }
  }

  const at = new Date().toISOString()
  for (const o of digest.outcomes) {
    await must(db.from("cas_queue").update({ processed_at: at, outcome: o.outcome }).eq("id", o.id))
  }
  return pending.length
}
