import type { CasSnapshot, CasStore, SyncMark } from "@/lib/cas/store"
import type { CasNote } from "@/lib/db/schema"
import type { PlanChange } from "@/lib/plan-service"

/** An in-memory CasStore over the plan's change log from memoryRepo. */
export function memoryCasStore(changes: PlanChange[], opts: { uncategorised?: number } = {}) {
  const snapshots: CasSnapshot[] = []
  const notes: CasNote[] = []
  const syncs: SyncMark[] = []
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
    async uncategorisedCount() {
      return opts.uncategorised ?? 0
    },
  }
  return { store, snapshots, notes, syncs }
}
