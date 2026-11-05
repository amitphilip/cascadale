import "server-only"

import { COLUMNS, getDb, must, type Db } from "@/lib/db"
import type { CasNote } from "@/lib/db/schema"
import type { PlanChange } from "@/lib/plan-service"
import { getCategorizationStats } from "@/lib/queries"

import type { CasSnapshot, CasStore, NewSnapshot, SyncMark } from "./store"

const SNAPSHOT_COLUMNS =
  "id, status, headline, goalGap:goal_gap, lowPointDate:low_point_date, lowPointAmount:low_point_amount, topActions:top_actions, warnings, proposals, figures, basedOnSyncAt:based_on_sync_at, basedOnSyncRunId:based_on_sync_run_id, basedOnChangeId:based_on_change_id, model, escalationReason:escalation_reason, inputTokens:input_tokens, outputTokens:output_tokens, latencyMs:latency_ms, error, createdAt:created_at"
const CHANGE_COLUMNS =
  "id, operationId:operation_id, actor, action, reason, summary, createdAt:created_at, completedAt:completed_at, before, after, transactionId:transaction_id"

type SnapshotRow = Omit<CasSnapshot, "lowPoint"> & { lowPointDate: string | null; lowPointAmount: number | null }

export function snapshotFromRow({ lowPointDate, lowPointAmount, ...r }: SnapshotRow): CasSnapshot {
  return {
    ...r,
    goalGap: r.goalGap === null ? null : Number(r.goalGap),
    lowPoint: lowPointDate === null ? null : { date: lowPointDate, amount: Number(lowPointAmount) },
  }
}

const syncMark = (r: { at: string; runId: string | null }): SyncMark => r

/** Cas's worker store as the signed-in user (or the household it runs as). */
export function supabaseCasStore(db: Db): CasStore {
  return {
    async latestSnapshot() {
      const [row] = await must<SnapshotRow[]>(
        db.from("cas_snapshots").select(SNAPSHOT_COLUMNS).order("id", { ascending: false }).limit(1)
      )
      return row ? snapshotFromRow(row) : null
    },
    async saveSnapshot({ lowPoint, ...s }: NewSnapshot) {
      const row = await must<SnapshotRow>(
        db
          .from("cas_snapshots")
          .insert({
            status: s.status,
            headline: s.headline,
            goal_gap: s.goalGap,
            low_point_date: lowPoint?.date ?? null,
            low_point_amount: lowPoint?.amount ?? null,
            top_actions: s.topActions,
            warnings: s.warnings,
            proposals: s.proposals,
            figures: s.figures,
            based_on_sync_at: s.basedOnSyncAt,
            based_on_sync_run_id: s.basedOnSyncRunId,
            based_on_change_id: s.basedOnChangeId,
            model: s.model,
            escalation_reason: s.escalationReason,
            input_tokens: s.inputTokens,
            output_tokens: s.outputTokens,
            latency_ms: s.latencyMs,
            error: s.error,
          })
          .select(SNAPSHOT_COLUMNS)
          .single()
      )
      return snapshotFromRow(row)
    },
    async latestChange() {
      const [row] = await must<{ id: number; createdAt: string }[]>(
        db
          .from("plan_changes")
          .select("id, createdAt:created_at")
          .not("completed_at", "is", null)
          .order("id", { ascending: false })
          .limit(1)
      )
      return row ?? null
    },
    changesSince(since) {
      return must<PlanChange[]>(
        db
          .from("plan_changes")
          .select(CHANGE_COLUMNS)
          .not("completed_at", "is", null)
          .gte("created_at", since)
          .order("id", { ascending: false })
          .limit(200)
      )
    },
    changesAfter(id) {
      let q = db.from("plan_changes").select(CHANGE_COLUMNS).not("completed_at", "is", null)
      if (id !== null) q = q.gt("id", id)
      return must<PlanChange[]>(q.order("id").limit(50))
    },
    async latestSync() {
      const [row] = await this.syncsAfter(null)
      return row ?? null
    },
    async syncsAfter(at) {
      let q = db
        .from("akahu_syncs")
        .select("at:finished_at, runId:run_id")
        .not("finished_at", "is", null)
        .is("error", null)
      if (at) q = q.gt("finished_at", at)
      const rows = await must<SyncMark[]>(q.order("finished_at", { ascending: false }).limit(20))
      // one mark per run: its accounts finish moments apart
      const seen = new Set<string>()
      return rows.filter((r) => !r.runId || (!seen.has(r.runId) && seen.add(r.runId))).map(syncMark)
    },
    openNotes() {
      return must<CasNote[]>(
        db.from("cas_notes").select(COLUMNS.casNotes).is("resolved_at", null).order("id", { ascending: false }).limit(50)
      )
    },
    saveNote({ kind, content }) {
      return must<CasNote>(db.from("cas_notes").insert({ kind, content }).select(COLUMNS.casNotes).single())
    },
    async uncategorisedCount() {
      return Number((await getCategorizationStats())?.uncategorized ?? 0)
    },
  }
}

export async function casStore() {
  return supabaseCasStore(await getDb())
}
