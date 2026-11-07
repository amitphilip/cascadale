import "server-only"

import { getDb, must, selectAll, type Db } from "@/lib/db"
import { DEFAULT_MONEY, formatMoney } from "@/lib/format"
import { merchantKey } from "@/lib/rules"
import {
  UNCATEGORIZED_REF,
  todoChanges,
  uncategorizedTodos,
  type RefNote,
} from "@/supabase/functions/_shared/uncategorized-todos"

/** Resolved to-dos looked at so one the user dismissed isn't raised again. */
const DISMISSED_DAYS = 90

/**
 * Bring Cas's to-dos for uncategorized synced transactions up to date (the akahu-sync
 * edge function does the same after each sync): one per merchant, resolved once it's
 * categorized. Returns how many it added.
 */
export async function syncUncategorizedTodos(db?: Db) {
  db ??= await getDb()
  const [rows, settings, notes] = await Promise.all([
    selectAll<{ description: string; amount: number }>((from, to) =>
      db
        .from("transactions")
        .select("description, amount")
        .eq("source", "akahu")
        .is("category_id", null)
        // not ones you left uncategorized on purpose
        .or("category_source.is.null,category_source.neq.manual")
        .order("id")
        .range(from, to)
    ),
    must<{ key: string; value: string }[]>(
      db.from("settings").select("key, value").in("key", ["currency", "locale"])
    ),
    must<(RefNote & { resolvedAt: string | null })[]>(
      db
        .from("cas_notes")
        .select("id, ref, content, resolvedAt:resolved_at")
        .like("ref", `${UNCATEGORIZED_REF}%`)
        .or(
          `resolved_at.is.null,resolved_at.gte.${new Date(Date.now() - DISMISSED_DAYS * 864e5).toISOString()}`
        )
    ),
  ])
  const get = (key: string) => settings.find((s) => s.key === key)?.value
  const fmt = {
    currency: get("currency") ?? DEFAULT_MONEY.currency,
    locale: get("locale") ?? DEFAULT_MONEY.locale,
  }
  const wanted = uncategorizedTodos(
    rows.map((r) => ({ ...r, amount: Number(r.amount) })),
    merchantKey,
    (n) => formatMoney(n, fmt)
  )
  const changes = todoChanges(
    wanted,
    notes.filter((n) => n.resolvedAt === null),
    notes.filter((n) => n.resolvedAt !== null)
  )
  if (changes.insert.length > 0) {
    await must(
      db.from("cas_notes").insert(changes.insert.map((t) => ({ kind: "todo", ...t })))
    )
  }
  for (const u of changes.update) {
    await must(db.from("cas_notes").update({ content: u.content }).eq("id", u.id))
  }
  if (changes.resolve.length > 0) {
    await must(
      db
        .from("cas_notes")
        .update({ resolved_at: new Date().toISOString(), resolution: "No longer uncategorised" })
        .in("id", changes.resolve)
    )
  }
  return changes.insert.length
}
