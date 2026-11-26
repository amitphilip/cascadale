import "server-only"

import { DbError, getDb, must } from "@/lib/db"
import type { ShortTermLine } from "@/lib/short-term"

// Reading and saving Cas's short-term allocations (short_term_allocations), as the signed-in
// user: row level security keeps it to the household.

export type ShortTerm = {
  id: number
  memberId: string
  cycleStart: string
  cycleEnd: string
  lines: ShortTermLine[]
  summary: string | null
  fingerprint: string
  madeBy: "cas" | "claude" | "you"
  updatedAt: string
}

const COLUMNS =
  "id, memberId:member_id, cycleStart:cycle_start, cycleEnd:cycle_end, lines, summary, fingerprint, madeBy:made_by, updatedAt:updated_at"

/** One person's short-term allocation for the pay cycle that starts on `cycleStart`. */
export async function getShortTerm(memberId: string, cycleStart: string) {
  const { data, error } = await (await getDb())
    .from("short_term_allocations")
    .select(COLUMNS)
    .eq("member_id", memberId)
    .eq("cycle_start", cycleStart)
    .maybeSingle()
  // before the migration's applied, there's no short-term allocation yet
  if (error?.code === MISSING_TABLE) return null
  if (error) throw new DbError(error)
  const row = data as ShortTerm | null
  return row && { ...row, lines: row.lines.map((l) => ({ ...l, amount: Number(l.amount) })) }
}

/** What PostgREST says when a table isn't in its schema cache. */
const MISSING_TABLE = "PGRST205"

/** Whether short_term_allocations exists yet, so Cas isn't asked for lines it can't save. */
export async function shortTermReady() {
  const { error } = await (await getDb()).from("short_term_allocations").select("id").limit(1)
  return error?.code !== MISSING_TABLE
}

/** Save one person's short-term allocation for a pay cycle, replacing what was there. */
export async function saveShortTerm(row: {
  memberId: string
  cycleStart: string
  cycleEnd: string
  lines: ShortTermLine[]
  summary: string | null
  fingerprint: string
  madeBy: "cas" | "claude" | "you"
}) {
  return must<ShortTerm>(
    (await getDb())
      .from("short_term_allocations")
      .upsert(
        {
          member_id: row.memberId,
          cycle_start: row.cycleStart,
          cycle_end: row.cycleEnd,
          lines: row.lines,
          summary: row.summary,
          fingerprint: row.fingerprint,
          made_by: row.madeBy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,member_id,cycle_start" }
      )
      .select(COLUMNS)
      .single()
  )
}
