import type { PlanChange } from "@/lib/plan-service"

import type { CasSnapshot, CasStore, SyncMark } from "./store"

/**
 * get_status: Cas's latest snapshot and whether anything has happened since, without a
 * model. A snapshot is stale when a sync finished or a change was recorded after the ones
 * it's based on; Cas's next run (debounced) will catch up.
 */
export function statusOf(
  snapshot: CasSnapshot | null,
  newer: { changes: PlanChange[]; syncs: SyncMark[] },
  now: Date
) {
  const changes = newer.changes.map((c) => ({
    changeId: c.id,
    at: c.createdAt,
    actor: c.actor,
    action: c.action,
    summary: c.summary,
  }))
  const syncs = newer.syncs.map((s) => ({ at: s.at, syncRunId: s.runId }))
  return {
    snapshot,
    is_stale: snapshot === null || changes.length > 0 || syncs.length > 0,
    newer: { changes, syncs },
    ageMinutes: snapshot ? Math.round((now.getTime() - Date.parse(snapshot.createdAt)) / 60_000) : null,
    ...(snapshot === null ? { hint: "Cas hasn't written a snapshot yet: call refresh_cas" } : {}),
  }
}

export async function loadStatus(store: CasStore, now = new Date()) {
  const snapshot = await store.latestSnapshot()
  const [changes, syncs] = await Promise.all([
    store.changesAfter(snapshot?.basedOnChangeId ?? null),
    store.syncsAfter(snapshot?.basedOnSyncAt ?? null),
  ])
  return statusOf(snapshot, { changes, syncs }, now)
}
