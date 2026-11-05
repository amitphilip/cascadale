import "server-only"

import { COLUMNS, DbError, getDb, getOwnerId, must, type Db } from "@/lib/db"
import { emit } from "@/lib/events"
import type { PlanAction } from "@/lib/db/schema"
import type { PlanSnapshot } from "@/lib/plan"
import type { Actor, AdjustmentInstruction, PotInstruction } from "@/lib/plan-instructions"
import { getGoalThread, getPlanThread } from "@/lib/queries"
import type { PlanChange, PlanDeps, PlanRecord, PlanRepo } from "@/lib/plan-service"
import { loadSnapshot } from "@/lib/planner"

// The plan service's tables (plan_pots, plan_adjustments, plan_changes, plan_threads and
// cas_notes) as the signed-in user, so row level security scopes every query to their
// household, exactly as the Plan page reads them.

const POT_COLUMNS =
  "id, name, amount, frequency, fromAccountId:from_account_id, toAccountId:to_account_id, incomeKey:income_key, incomeName:income_name, covers, note, removed, updatedBy:updated_by, updatedAt:updated_at, reason"
const ADJUSTMENT_COLUMNS =
  "id, date, kind, target, ref, name, amount, fromAccountId:from_account_id, toAccountId:to_account_id, createdBy:created_by, createdAt:created_at, reason"
const CHANGE_COLUMNS =
  "id, operationId:operation_id, actor, action, reason, summary, result, createdAt:created_at, completedAt:completed_at, transactionId:transaction_id"

const pot = (r: PotInstruction): PotInstruction => ({ ...r, amount: Number(r.amount) })
const adjustment = (r: AdjustmentInstruction): AdjustmentInstruction => ({
  ...r,
  amount: r.amount === null ? null : Number(r.amount),
})

export function supabasePlanRepo(db: Db): PlanRepo {
  return {
    async claim({ operationId, actor, action, reason, transactionId }) {
      try {
        const change = await must<PlanChange>(
          db
            .from("plan_changes")
            .insert({ operation_id: operationId, actor, action, reason, transaction_id: transactionId ?? null })
            .select(CHANGE_COLUMNS)
            .single()
        )
        return { change, existing: false }
      } catch (err) {
        // unique_violation: this operation id was used before
        if (!(err instanceof DbError) || err.code !== "23505") throw err
        const change = await must<PlanChange>(
          db.from("plan_changes").select(CHANGE_COLUMNS).eq("operation_id", operationId).single()
        )
        return { change, existing: true }
      }
    },
    async complete(id, summary, result, { before, after }) {
      await must(
        db
          .from("plan_changes")
          .update({ summary, result, before, after, completed_at: new Date().toISOString() })
          .eq("id", id)
      )
    },
    async release(id) {
      await must(db.from("plan_changes").delete().eq("id", id))
    },
    listChanges(limit) {
      return must<PlanChange[]>(
        db.from("plan_changes").select(CHANGE_COLUMNS).order("id", { ascending: false }).limit(limit)
      )
    },

    async listPots() {
      return (await must<PotInstruction[]>(db.from("plan_pots").select(POT_COLUMNS).order("id"))).map(pot)
    },
    async savePot({ id, ...p }) {
      const row = {
        name: p.name,
        amount: p.amount,
        frequency: p.frequency,
        from_account_id: p.fromAccountId,
        to_account_id: p.toAccountId,
        income_key: p.incomeKey,
        income_name: p.incomeName,
        covers: p.covers,
        note: p.note,
        removed: p.removed,
        updated_by: p.updatedBy,
        updated_at: new Date().toISOString(),
        reason: p.reason,
      }
      const query = id
        ? db.from("plan_pots").update(row).eq("id", id)
        : db.from("plan_pots").insert(row)
      return pot(await must<PotInstruction>(query.select(POT_COLUMNS).single()))
    },

    async listAdjustments() {
      return (
        await must<AdjustmentInstruction[]>(
          db
            .from("plan_adjustments")
            .select(ADJUSTMENT_COLUMNS)
            .is("removed_at", null)
            .order("date")
            .order("id")
        )
      ).map(adjustment)
    },
    async addAdjustment(a) {
      return adjustment(
        await must<AdjustmentInstruction>(
          db
            .from("plan_adjustments")
            .insert({
              date: a.date,
              kind: a.kind,
              target: a.target,
              ref: a.ref,
              name: a.name,
              amount: a.amount,
              from_account_id: a.fromAccountId,
              to_account_id: a.toAccountId,
              created_by: a.createdBy,
              reason: a.reason,
            })
            .select(ADJUSTMENT_COLUMNS)
            .single()
        )
      )
    },
    async removeAdjustment(id, by, reason) {
      const [row] = await must<AdjustmentInstruction[]>(
        db
          .from("plan_adjustments")
          .update({ removed_at: new Date().toISOString(), removed_by: by, removed_reason: reason })
          .eq("id", id)
          .is("removed_at", null)
          .select(ADJUSTMENT_COLUMNS)
      )
      return row ? adjustment(row) : null
    },

    latestPlan: async () => planRecord(await getPlanThread()),
    goalPlan: async () => planRecord(await getGoalThread()),

    listActions(includeDone) {
      let query = db.from("plan_actions").select(COLUMNS.planActions).order("id").limit(500)
      if (!includeDone) query = query.is("done_at", null)
      return must<PlanAction[]>(query)
    },
    addAction(a) {
      return must<PlanAction>(
        db
          .from("plan_actions")
          .insert({
            title: a.title,
            detail: a.detail,
            due_date: a.dueDate,
            focus_title: a.focusTitle,
            created_by: a.createdBy,
          })
          .select(COLUMNS.planActions)
          .single()
      )
    },
    async setActionDone(id, done) {
      const [row] = await must<PlanAction[]>(
        db
          .from("plan_actions")
          .update({ done_at: done ? new Date().toISOString() : null })
          .eq("id", id)
          .select(COLUMNS.planActions)
      )
      return row ?? null
    },
    async removeAction(id) {
      const [row] = await must<PlanAction[]>(
        db.from("plan_actions").delete().eq("id", id).select(COLUMNS.planActions)
      )
      return row ?? null
    },

    openDecisions() {
      return must(
        db
          .from("cas_notes")
          .select("id, content, createdAt:created_at")
          .eq("kind", "decision")
          .eq("affects_plan", true)
          .is("applied_at", null)
          .is("resolved_at", null)
          .order("id")
      )
    },
    async applyDecisions(ids, changeId) {
      if (!ids.length) return []
      return must(
        db
          .from("cas_notes")
          .update({ applied_at: new Date().toISOString(), applied_change_id: changeId })
          .in("id", ids)
          .eq("affects_plan", true)
          .is("applied_at", null)
          .select("id, content, createdAt:created_at")
      )
    },
  }
}

type Thread = Awaited<ReturnType<typeof getPlanThread>>

/** A thread's latest plan message, with the snapshot it was made on. */
function planRecord(thread: Thread): PlanRecord | null {
  const message = thread?.messages.findLast((m) => m.plan)
  if (!thread || !message?.plan) return null
  return {
    id: message.id,
    threadId: thread.id,
    createdAt: message.createdAt,
    madeBy: thread.madeBy,
    snapshot: thread.snapshot,
    plan: message.plan,
  }
}

/**
 * The plan service as the signed-in user, acting as `actor`. Every recorded change emits
 * plan/changed for Cas's worker, unless `quiet` (the worker's own writes, which it's
 * already accounting for).
 */
export async function planDeps(actor: Actor, opts: { quiet?: boolean } = {}): Promise<PlanDeps> {
  const db = await getDb()
  return {
    repo: supabasePlanRepo(db),
    loadSnapshot: loadSnapshot as () => Promise<PlanSnapshot | null>,
    actor,
    onChange: opts.quiet
      ? undefined
      : async (change) => {
          await emit({
            name: "plan/changed",
            data: { householdId: await getOwnerId(db), changeId: change.id, actor: change.actor, action: change.action },
          })
        },
  }
}
