import { recordChange, type PlanDeps } from "@/lib/plan-service"

import type { CasStore } from "./store"

export type DiscrepancyInput = {
  /** what the raw data shows */
  what: string
  /** what the snapshot says instead */
  snapshotSays?: string | null
  /** the facts behind it: ids, amounts, dates */
  evidence?: string | null
  snapshotId?: number | null
  operationId?: string
}

/**
 * Claude saw something in the raw data that disagrees with Cas's snapshot: save it as a
 * discrepancy note, recorded on the change log (which emits plan/changed and makes the
 * snapshot stale), so Cas reconciles it on its next run.
 */
export async function reportDiscrepancy(deps: PlanDeps, store: CasStore, input: DiscrepancyInput) {
  const what = input.what.trim()
  if (!what) throw new Error("Say what doesn't match")
  const content = [
    what,
    input.snapshotSays?.trim() && `The snapshot${input.snapshotId ? ` (${input.snapshotId})` : ""} says: ${input.snapshotSays.trim()}`,
    input.evidence?.trim() && `Evidence: ${input.evidence.trim()}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000)
  return recordChange(
    deps,
    "report_discrepancy",
    { operationId: input.operationId?.trim() || crypto.randomUUID(), reason: what.slice(0, 500) },
    async () => {
      const note = await store.saveNote({ kind: "discrepancy", content })
      return {
        summary: `Discrepancy reported: ${what.slice(0, 120)}`,
        result: { noteId: note.id, changed: { note: { before: null, after: note } } },
      }
    }
  )
}
