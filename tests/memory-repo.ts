import type { Plan, PlanSnapshot } from "@/lib/plan"
import type { Actor, AdjustmentInstruction, PotInstruction } from "@/lib/plan-instructions"
import type { PlanChange, PlanDecision, PlanRecord, PlanRepo } from "@/lib/plan-service"

/**
 * An in-memory PlanRepo with the same behaviour as the Supabase one (lib/plan-repo.ts):
 * unique operation ids, pots unique by name, removed adjustments kept out of the list.
 * Timestamps come from a clock that ticks a second per write, so ordering is stable.
 */
/** A copy of a row without the bookkeeping field the real tables keep out of their selects. */
function without<T extends object, K extends keyof T>(row: T, key: K): Omit<T, K> {
  const out = structuredClone(row)
  delete out[key]
  return out
}

export function memoryRepo(seed: { plan?: Omit<PlanRecord, "id" | "threadId">; decisions?: string[] } = {}) {
  let clock = Date.parse("2026-10-28T09:00:00Z")
  const now = () => new Date((clock += 1000)).toISOString()
  let ids = 0
  const nextId = () => ++ids

  const changes: PlanChange[] = []
  const pots: PotInstruction[] = []
  const adjustments: (AdjustmentInstruction & { removedAt: string | null })[] = []
  const plans: PlanRecord[] = []
  const decisions = (seed.decisions ?? []).map((content) => ({
    id: nextId(),
    content,
    createdAt: now(),
    appliedAt: null as string | null,
  }))
  if (seed.plan) plans.push({ ...seed.plan, id: nextId(), threadId: nextId() })

  const repo: PlanRepo = {
    async claim({ operationId, actor, action, reason }) {
      const existing = changes.find((c) => c.operationId === operationId)
      if (existing) return { change: existing, existing: true }
      const change: PlanChange = {
        id: nextId(),
        operationId,
        actor,
        action,
        reason,
        summary: null,
        result: null,
        createdAt: now(),
        completedAt: null,
      }
      changes.push(change)
      return { change, existing: false }
    },
    async complete(id, summary, result) {
      const c = changes.find((x) => x.id === id)!
      Object.assign(c, { summary, result: structuredClone(result), completedAt: now() })
    },
    async release(id) {
      changes.splice(changes.findIndex((c) => c.id === id), 1)
    },
    async listChanges(limit) {
      return changes.toReversed().slice(0, limit)
    },
    async listPots() {
      return structuredClone(pots)
    },
    async savePot({ id, ...p }) {
      if (!id && pots.some((x) => x.name.toLowerCase() === p.name.toLowerCase()))
        throw new Error("duplicate pot name")
      const row: PotInstruction = { ...p, id: id ?? nextId(), updatedAt: now() }
      const i = pots.findIndex((x) => x.id === row.id)
      if (i >= 0) pots[i] = row
      else pots.push(row)
      return structuredClone(row)
    },
    async listAdjustments() {
      return adjustments
        .filter((a) => a.removedAt === null)
        .map((a) => without(a, "removedAt"))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    },
    async addAdjustment(a) {
      const row = { ...a, id: nextId(), createdAt: now(), removedAt: null }
      adjustments.push(row)
      return without(row, "removedAt")
    },
    async removeAdjustment(id) {
      const a = adjustments.find((x) => x.id === id && x.removedAt === null)
      if (!a) return null
      a.removedAt = now()
      return without(a, "removedAt")
    },
    async latestPlan() {
      return plans.at(-1) ? structuredClone(plans.at(-1)!) : null
    },
    async savePlan({ snapshot, plan, madeBy }) {
      const record: PlanRecord = {
        id: nextId(),
        threadId: nextId(),
        createdAt: now(),
        madeBy,
        snapshot: structuredClone(snapshot) as PlanSnapshot,
        plan: structuredClone(plan) as Plan,
      }
      plans.push(record)
      return structuredClone(record)
    },
    async openDecisions(): Promise<PlanDecision[]> {
      return decisions.filter((d) => d.appliedAt === null).map((d) => without(d, "appliedAt"))
    },
    async applyDecisions(list) {
      const out = decisions.filter((d) => list.includes(d.id) && d.appliedAt === null)
      for (const d of out) d.appliedAt = now()
      return out.map((d) => without(d, "appliedAt"))
    },
  }
  return { repo, changes, pots, adjustments, plans, decisions }
}

export const ACTOR: Actor = "mcp"
