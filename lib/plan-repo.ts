import "server-only"

import { DbError, getDb, must, type Db } from "@/lib/db"
import type { PlanSnapshot } from "@/lib/plan"
import type { PotEntry } from "@/lib/pots"
import type { Actor, AdjustmentInstruction, PotInstruction } from "@/lib/plan-instructions"
import { getPlanThread } from "@/lib/queries"
import type { PlanChange, PlanDeps, PlanRepo } from "@/lib/plan-service"
import { loadSnapshot } from "@/lib/planner"

// The plan service's tables (plan_pots, plan_adjustments, plan_changes, plan_threads and
// cas_notes) as the signed-in user, so row level security scopes every query to their
// household, exactly as the Plan page reads them.

const POT_COLUMNS =
  "id, name, type, amount, frequency, fromAccountId:from_account_id, toAccountId:to_account_id, incomeKey:income_key, incomeName:income_name, covers, note, capAmount:cap_amount, endDate:end_date, resetDate:reset_date, resetMode:reset_mode, scheduledFrom:scheduled_from, removed, updatedBy:updated_by, updatedAt:updated_at, reason"
const ENTRY_COLUMNS =
  "id, potId:pot_id, kind, amount, date, transactionId:transaction_id, note, scheduled, createdBy:created_by, createdAt:created_at, transaction:transactions(date, description, amount, accountId:account_id)"
const ADJUSTMENT_COLUMNS =
  "id, date, kind, target, ref, name, amount, fromAccountId:from_account_id, toAccountId:to_account_id, createdBy:created_by, createdAt:created_at, reason"
const CHANGE_COLUMNS =
  "id, operationId:operation_id, actor, action, reason, summary, result, createdAt:created_at, completedAt:completed_at"

const pot = (r: PotInstruction): PotInstruction => ({
  ...r,
  amount: Number(r.amount),
  capAmount: r.capAmount === null ? null : Number(r.capAmount),
})
const entry = (r: PotEntry): PotEntry => ({
  ...r,
  amount: Number(r.amount),
  transaction: r.transaction && { ...r.transaction, amount: Number(r.transaction.amount) },
})
const adjustment = (r: AdjustmentInstruction): AdjustmentInstruction => ({
  ...r,
  amount: r.amount === null ? null : Number(r.amount),
})

export function supabasePlanRepo(db: Db): PlanRepo {
  return {
    async claim({ operationId, actor, action, reason }) {
      try {
        const change = await must<PlanChange>(
          db
            .from("plan_changes")
            .insert({ operation_id: operationId, actor, action, reason })
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
    async complete(id, summary, result) {
      await must(
        db
          .from("plan_changes")
          .update({ summary, result, completed_at: new Date().toISOString() })
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
        type: p.type,
        cap_amount: p.capAmount,
        end_date: p.endDate,
        reset_date: p.resetDate,
        reset_mode: p.resetMode,
        scheduled_from: p.scheduledFrom,
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

    async listPotEntries() {
      return (
        await must<PotEntry[]>(db.from("pot_entries").select(ENTRY_COLUMNS).order("date").order("id"))
      ).map(entry)
    },
    async addPotEntry(e) {
      return entry(
        await must<PotEntry>(
          db
            .from("pot_entries")
            .insert({
              pot_id: e.potId,
              kind: e.kind,
              amount: e.amount,
              date: e.date,
              transaction_id: e.transactionId,
              note: e.note,
              scheduled: e.scheduled,
              created_by: e.createdBy,
            })
            .select(ENTRY_COLUMNS)
            .single()
        )
      )
    },
    async removePotEntry(id) {
      const [row] = await must<PotEntry[]>(db.from("pot_entries").delete().eq("id", id).select(ENTRY_COLUMNS))
      return row ? entry(row) : null
    },
    async getTransaction(id) {
      const [row] = await must<
        { id: number; date: string; description: string; amount: number; accountId: number; category: { name: string } | null }[]
      >(
        db
          .from("transactions")
          .select("id, date, description, amount, accountId:account_id, category:categories(name)")
          .eq("id", id)
      )
      return row ? { ...row, amount: Number(row.amount), category: row.category?.name ?? null } : null
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

    async latestPlan() {
      const thread = await getPlanThread()
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

/** The plan service as the signed-in user, acting as `actor`. */
export async function planDeps(actor: Actor): Promise<PlanDeps> {
  return { repo: supabasePlanRepo(await getDb()), loadSnapshot: loadSnapshot as () => Promise<PlanSnapshot | null>, actor }
}
