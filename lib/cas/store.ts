import type { CasNote } from "@/lib/db/schema"
import type { GoalTone } from "@/lib/plan-goal"
import type { PlanChange } from "@/lib/plan-service"

/** What Cas's worker reads and writes besides the plan (lib/cas/store-db.ts, or in memory in tests). */

export type SnapshotWarning = {
  kind: "drift" | "stale_feed" | "uncategorised" | "overdraft" | "series" | "other"
  message: string
}

export type TopAction = {
  title: string
  detail: string | null
  /** the plan action item it's about, when it is one */
  actionId: number | null
  dueDate: string | null
}

export type SnapshotProposal = { proposalId: number | null; tool: string; args: unknown; reason: string }

export type CasSnapshot = {
  id: number
  status: GoalTone
  headline: string
  goalGap: number | null
  lowPoint: { date: string; amount: number } | null
  topActions: TopAction[]
  warnings: SnapshotWarning[]
  proposals: SnapshotProposal[]
  figures: unknown
  basedOnSyncAt: string | null
  basedOnSyncRunId: string | null
  basedOnChangeId: number | null
  model: string | null
  escalationReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  error: string | null
  createdAt: string
}

export type NewSnapshot = Omit<CasSnapshot, "id" | "createdAt">

export type SyncMark = { at: string; runId: string | null }

export interface CasStore {
  latestSnapshot(): Promise<CasSnapshot | null>
  saveSnapshot(s: NewSnapshot): Promise<CasSnapshot>
  /** the latest completed change */
  latestChange(): Promise<{ id: number; createdAt: string } | null>
  /** completed changes from this date on, newest first */
  changesSince(since: string): Promise<PlanChange[]>
  /** completed changes after this id, oldest first */
  changesAfter(id: number | null): Promise<PlanChange[]>
  /** the latest finished, successful sync */
  latestSync(): Promise<SyncMark | null>
  /** finished syncs after this time, newest first */
  syncsAfter(at: string | null): Promise<SyncMark[]>
  openNotes(): Promise<CasNote[]>
  saveNote(note: { kind: CasNote["kind"]; content: string }): Promise<CasNote>
  uncategorisedCount(): Promise<number>
}
