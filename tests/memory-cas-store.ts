import type { CasSnapshot, CasStore, Proposal, SyncMark } from "@/lib/cas/store"
import type { CasNote } from "@/lib/db/schema"
import type { PlanChange } from "@/lib/plan-service"

/** An in-memory CasStore over the plan's change log from memoryRepo. */
export function memoryCasStore(changes: PlanChange[], opts: { uncategorised?: number } = {}) {
  const snapshots: CasSnapshot[] = []
  const notes: CasNote[] = []
  const syncs: SyncMark[] = []
  const proposals: Proposal[] = []
  let ids = 1000
  const done = () => changes.filter((c) => c.completedAt !== null)
  const store: CasStore = {
    async latestSnapshot() {
      return snapshots.at(-1) ?? null
    },
    async saveSnapshot(s) {
      const row = { ...structuredClone(s), id: ++ids, createdAt: new Date().toISOString() }
      snapshots.push(row)
      return row
    },
    async latestChange() {
      const c = done().at(-1)
      return c ? { id: c.id, createdAt: c.createdAt } : null
    },
    async changesSince(since) {
      return done().filter((c) => c.createdAt >= since).toReversed()
    },
    async changesAfter(id) {
      return done().filter((c) => id === null || c.id > id)
    },
    async latestSync() {
      return syncs.at(-1) ?? null
    },
    async syncsAfter(at) {
      return syncs.filter((s) => at === null || s.at > at).toReversed()
    },
    async openNotes() {
      return notes.filter((n) => n.resolvedAt === null)
    },
    async saveNote({ kind, content }) {
      const n: CasNote = {
        id: ++ids,
        kind,
        content,
        dueDate: null,
        affectsPlan: false,
        appliedAt: null,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        resolution: null,
      }
      notes.push(n)
      return n
    },
    async resolveNote(id, resolution) {
      const n = notes.find((x) => x.id === id && x.resolvedAt === null)
      if (!n) return null
      Object.assign(n, { resolvedAt: new Date().toISOString(), resolution })
      return structuredClone(n)
    },
    async uncategorisedCount() {
      return opts.uncategorised ?? 0
    },
    async listProposals(statuses, limit = 50) {
      return structuredClone(proposals.filter((p) => statuses.includes(p.status)).toReversed().slice(0, limit))
    },
    async getProposal(id) {
      return structuredClone(proposals.find((p) => p.id === id) ?? null)
    },
    async addProposals(rows) {
      const added = rows.map(
        (r): Proposal => ({
          ...structuredClone(r),
          id: ++ids,
          status: "pending",
          createdAt: new Date().toISOString(),
          decidedAt: null,
          decisionReason: null,
          changeId: null,
          result: null,
          error: null,
        })
      )
      proposals.push(...added)
      return structuredClone(added)
    },
    async settleProposal(id, patch) {
      const p = proposals.find((x) => x.id === id && x.status === "pending")
      if (!p) return null
      Object.assign(p, {
        status: patch.status,
        decisionReason: patch.reason ?? null,
        changeId: patch.changeId ?? null,
        result: structuredClone(patch.result ?? null),
        error: patch.error ?? null,
        decidedAt: new Date().toISOString(),
      })
      return structuredClone(p)
    },
  }
  return { store, snapshots, notes, syncs, proposals }
}
