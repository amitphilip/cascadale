import "server-only"

import { z } from "zod"

import { COLUMNS, getDb, must } from "@/lib/db"
import { PLAN_EVERY, PLAN_PURPOSES, type ChangeMaker, type PlanItem } from "@/lib/db/schema"
import { getCurrentPlan } from "@/lib/plan-data"
import { getMembers, householdAccounts, standingRules } from "@/lib/planning/data"
import { payerConflicts } from "@/lib/planning/plan-check"
import { getPeople } from "@/lib/queries"

// Editing the long-term plan. Every change is a pending change first: Claude (or the app)
// proposes it with a reason, and a member approves it before it touches the plan. A change
// to a shared item (one paid from or into a joint account, or with no one member paying it:
// the mortgage, daycare) takes either member's approval; a personal one takes its owner's.
// Approving is done as yourself, so Claude can only approve for the person it's talking to,
// once they've said yes. Every applied change is logged in plan_changes with who asked, who
// made it, why, and the item before and after.

const round2 = (n: number) => Math.round(n * 100) / 100

/** The plan item fields a change can set. */
export const PlanItemFields = z.object({
  title: z.string().trim().min(1).max(80),
  purpose: z.enum(PLAN_PURPOSES),
  fromMemberId: z.string().uuid().nullable().optional().describe("Whose pay it comes from (member id); omit to take it from fromAccountId's holder. With no member and no holder (a joint account), it's shared."),
  fromAccountId: z.number().int().positive().nullable().optional().describe("The account the money leaves (usually where the pay lands); null when nothing moves"),
  toAccountId: z.number().int().positive().nullable().optional().describe("The account it goes into or sits in; null when it leaves the household"),
  amount: z.number().nonnegative(),
  every: z.enum(PLAN_EVERY),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  target: z.number().nonnegative().nullable().optional().describe("For savings, debt or a one-off: the amount it works towards"),
  matchKeys: z.array(z.string().trim().min(1)).max(20).optional().describe('What pays it, for plan_vs_actual: merchant keys, or "to:<accountId>" for a transfer'),
  categoryId: z.number().int().positive().nullable().optional(),
  oneOffId: z.number().int().positive().nullable().optional(),
})
export type PlanItemInput = z.infer<typeof PlanItemFields>

/** An item as it's stored, in the change log's shape. */
type ItemValues = {
  title: string
  purpose: string | null
  fromMemberId: string | null
  fromAccountId: number | null
  toAccountId: number | null
  amount: number | null
  every: string | null
  startDate: string | null
  endDate: string | null
  notes: string | null
  target: number | null
  matchKeys: string[]
  categoryId: number | null
  oneOffId: number | null
}

const values = (i: PlanItem): ItemValues => ({
  title: i.title,
  purpose: i.purpose,
  fromMemberId: i.fromMemberId,
  fromAccountId: i.fromAccountId,
  toAccountId: i.accountId,
  amount: i.amount === null ? null : Number(i.amount),
  every: i.every,
  startDate: i.startDate,
  endDate: i.endDate,
  notes: i.notes ?? i.detail,
  target: i.target === null ? null : Number(i.target),
  matchKeys: i.matchKeys ?? [],
  categoryId: i.categoryId,
  oneOffId: i.oneOffId,
})

export type Who = { askedBy: string | null; madeBy: ChangeMaker; reason: string }

function needReason(reason: string | undefined | null) {
  const r = reason?.trim()
  if (!r) throw new Error("Give a reason: every plan change records why it was made.")
  return r
}

/** Record a change in the log. */
export async function logChange(row: {
  entity: "plan_item" | "short_term" | "purchase" | "pending"
  entityId: number | null
  action: "create" | "update" | "remove" | "set" | "commit" | "approve" | "reject" | "propose"
  who: Who
  before?: unknown
  after?: unknown
}) {
  return must<{ id: number }>(
    (await getDb())
      .from("plan_changes")
      .insert({
        entity: row.entity,
        entity_id: row.entityId,
        action: row.action,
        asked_by: row.who.askedBy,
        made_by: row.who.madeBy,
        reason: needReason(row.who.reason),
        before: row.before ?? null,
        after: row.after ?? null,
      })
      .select("id")
      .single()
  )
}

async function planItem(id: number) {
  const [item] = await must<PlanItem[]>((await getDb()).from("plan_items").select(COLUMNS.planItems).eq("id", id))
  return item ?? null
}

/** The current plan's id, starting a plan for Claude to keep when there's none. */
async function currentPlanId(madeBy: ChangeMaker) {
  const current = await getCurrentPlan()
  if (current) return current.plan.id
  const { id } = await must<{ id: number }>(
    (await getDb())
      .from("plans")
      .insert({
        summary: "Kept item by item through Cascadale's plan tools.",
        verdict: null,
        verdict_note: null,
        figures: { income: 0, committed: 0, oneOffs: 0, leftOver: 0 },
        made_by: madeBy,
      })
      .select("id")
      .single()
  )
  return id
}

/**
 * A proposed item checked against the household: its accounts exist, its dates are in order,
 * and it doesn't break a standing rule about who pays for what (unless `override`).
 * Returns the item with whose pay it is filled in from its account's holder, and whether
 * it's shared.
 */
async function checkItem(item: ItemValues, override: boolean) {
  const [accounts, rules, people] = await Promise.all([householdAccounts(), standingRules(), getPeople()])
  const byId = new Map(accounts.map((a) => [a.id, a]))
  for (const [field, id] of [["fromAccountId", item.fromAccountId], ["toAccountId", item.toAccountId]] as const) {
    if (id !== null && !byId.has(id)) throw new Error(`${field} ${id} isn't one of the household's accounts`)
  }
  if (item.fromMemberId && !people.some((p) => p.id === item.fromMemberId)) {
    throw new Error(`fromMemberId ${item.fromMemberId} isn't a household member`)
  }
  if (item.startDate && item.endDate && item.endDate < item.startDate) throw new Error("endDate is before startDate")
  const filled = {
    ...item,
    fromMemberId:
      item.fromMemberId !== undefined && item.fromMemberId !== null
        ? item.fromMemberId
        : item.fromAccountId !== null
          ? (byId.get(item.fromAccountId)?.holderId ?? null)
          : null,
  }
  const nameOf = new Map(people.map((p) => [p.id, p.name]))
  const conflicts = payerConflicts(
    {
      id: null,
      title: filled.title,
      notes: filled.notes,
      purpose: filled.purpose as PlanItem["purpose"],
      amount: filled.amount,
      every: filled.every as PlanItem["every"],
      categoryId: filled.categoryId,
      accountId: filled.toAccountId,
      fromAccountId: filled.fromAccountId,
      fromMemberId: filled.fromMemberId,
    },
    rules,
    (id) => byId.get(id)?.holderId ?? null,
    (id) => nameOf.get(id) ?? "Someone"
  )
  if (conflicts.length && !override) {
    throw new Error(
      conflicts
        .map((c) => `This has ${c.plannedPayer} paying "${c.subject}", but decision note ${c.noteId} says ${c.payer} pays it: "${c.rule}"`)
        .join("; ") + ". Fix the payer, or pass override: true if the household has changed its mind (and update the note)."
    )
  }
  const touchesJoint = [filled.fromAccountId, filled.toAccountId].some((id) => id !== null && byId.get(id)?.holderId === null)
  const shared = filled.fromMemberId === null || touchesJoint
  return { item: filled, shared, conflicts }
}

export type PendingChange = {
  id: number
  kind: "upsert" | "remove"
  planItemId: number | null
  payload: ItemValues | Record<string, never>
  before: ItemValues | null
  reason: string
  askedBy: string | null
  madeBy: ChangeMaker
  shared: boolean
  approverId: string | null
  purchase: string | null
  status: "pending" | "approved" | "rejected"
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  createdAt: string
}

const PENDING_COLUMNS =
  "id, kind, planItemId:plan_item_id, payload, before, reason, askedBy:asked_by, madeBy:made_by, shared, approverId:approver_id, purchase, status, decidedBy:decided_by, decidedAt:decided_at, decisionReason:decision_reason, createdAt:created_at"

/**
 * Propose adding (no id) or changing a plan item. Fields left out of a change keep their
 * value. Nothing changes until a member approves it (approve_change).
 */
export async function proposeUpsert(
  input: Partial<PlanItemInput> & { id?: number | null },
  who: Who,
  opts: { override?: boolean; purchase?: string | null } = {}
) {
  needReason(who.reason)
  const existing = input.id ? await planItem(input.id) : null
  if (input.id && (!existing || existing.removedAt)) throw new Error(`Plan item ${input.id} not found`)
  if (existing && existing.kind !== "allocation") throw new Error(`Plan item ${input.id} is a to-do action, not an allocation`)
  const was = existing ? values(existing) : null
  const pick = <K extends keyof ItemValues>(k: K, v: ItemValues[K] | undefined, fallback: ItemValues[K]) =>
    v === undefined ? (was ? was[k] : fallback) : v
  const merged: ItemValues = {
    title: pick("title", input.title, ""),
    purpose: pick("purpose", input.purpose, null),
    fromMemberId: input.fromMemberId === undefined && input.fromAccountId !== undefined ? null : pick("fromMemberId", input.fromMemberId, null),
    fromAccountId: pick("fromAccountId", input.fromAccountId, null),
    toAccountId: pick("toAccountId", input.toAccountId, null),
    amount: pick("amount", input.amount === undefined ? undefined : round2(input.amount), null),
    every: pick("every", input.every, null),
    startDate: pick("startDate", input.startDate, null),
    endDate: pick("endDate", input.endDate, null),
    notes: pick("notes", input.notes, null),
    target: pick("target", input.target, null),
    matchKeys: pick("matchKeys", input.matchKeys, []),
    categoryId: pick("categoryId", input.categoryId, null),
    oneOffId: pick("oneOffId", input.oneOffId, null),
  }
  if (!merged.title) throw new Error("A new plan item needs a title")
  if (!merged.purpose) throw new Error("A new plan item needs a purpose")
  if (merged.amount === null || merged.every === null) throw new Error("A new plan item needs an amount and how often (every)")
  const { item, shared, conflicts } = await checkItem(merged, opts.override ?? false)

  const row = await must<PendingChange>(
    (await getDb())
      .from("pending_plan_changes")
      .insert({
        kind: "upsert",
        plan_item_id: existing?.id ?? null,
        payload: item,
        before: was,
        reason: who.reason.trim(),
        asked_by: who.askedBy,
        made_by: who.madeBy,
        shared,
        approver_id: shared ? null : item.fromMemberId,
        purchase: opts.purchase ?? null,
      })
      .select(PENDING_COLUMNS)
      .single()
  )
  await logChange({ entity: "pending", entityId: row.id, action: "propose", who, before: was, after: item })
  return { pending: await describePending(row), overriddenRules: conflicts }
}

/** Propose removing a plan item (a soft delete: its history stays). */
export async function proposeRemove(id: number, who: Who) {
  needReason(who.reason)
  const existing = await planItem(id)
  if (!existing || existing.removedAt) throw new Error(`Plan item ${id} not found`)
  const was = values(existing)
  const { shared, item } = await checkItem(was, true)
  const row = await must<PendingChange>(
    (await getDb())
      .from("pending_plan_changes")
      .insert({
        kind: "remove",
        plan_item_id: id,
        payload: {},
        before: was,
        reason: who.reason.trim(),
        asked_by: who.askedBy,
        made_by: who.madeBy,
        shared,
        approver_id: shared ? null : item.fromMemberId,
      })
      .select(PENDING_COLUMNS)
      .single()
  )
  await logChange({ entity: "pending", entityId: row.id, action: "propose", who, before: was, after: null })
  return { pending: await describePending(row) }
}

/** A pending change with names, and who can approve it. */
async function describePending(p: PendingChange) {
  const { members } = await getMembers()
  const name = (id: string | null) => (id === null ? null : (members.find((m) => m.id === id)?.name ?? "Someone"))
  return {
    ...p,
    askedByName: name(p.askedBy),
    approvableBy: p.shared ? members.map((m) => m.name) : [name(p.approverId) ?? "its owner"],
    decidedByName: name(p.decidedBy),
  }
}

export async function listPending(status: "pending" | "approved" | "rejected" | "all" = "pending") {
  let q = (await getDb()).from("pending_plan_changes").select(PENDING_COLUMNS).order("id", { ascending: false }).limit(100)
  if (status !== "all") q = q.eq("status", status)
  const rows = await must<PendingChange[]>(q)
  return Promise.all(rows.map(describePending))
}

async function pendingRow(id: number) {
  const [row] = await must<PendingChange[]>((await getDb()).from("pending_plan_changes").select(PENDING_COLUMNS).eq("id", id))
  if (!row) throw new Error(`Pending change ${id} not found`)
  if (row.status !== "pending") throw new Error(`Pending change ${id} was already ${row.status}`)
  return row
}

/** Checks that `memberId` is the signed-in member and may decide this change. */
async function decider(row: PendingChange, memberId: string) {
  const { members, you } = await getMembers()
  const m = members.find((x) => x.id === memberId || x.name.toLowerCase() === memberId.trim().toLowerCase())
  if (!m) throw new Error(`No household member "${memberId}"`)
  if (m.id !== you) {
    const me = members.find((x) => x.id === you)?.name ?? "the signed-in member"
    throw new Error(`Only ${m.name} can decide as ${m.name}: this session is signed in as ${me}. Ask ${m.name} to approve it in their own session.`)
  }
  if (!row.shared && row.approverId && row.approverId !== m.id) {
    const owner = members.find((x) => x.id === row.approverId)?.name ?? "its owner"
    throw new Error(`This change is to ${owner}'s own plan item, so only ${owner} can decide it.`)
  }
  return m
}

/** Approve a pending change as the signed-in member, and apply it to the plan. */
export async function approveChange(id: number, memberId: string, madeBy: ChangeMaker) {
  const row = await pendingRow(id)
  const m = await decider(row, memberId)
  const db = await getDb()
  const who: Who = { askedBy: row.askedBy, madeBy: row.madeBy, reason: row.reason }
  let planItemId = row.planItemId
  let after: ItemValues | null = null

  if (row.kind === "remove") {
    await must(db.from("plan_items").update({ removed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", planItemId!))
    await logChange({ entity: "plan_item", entityId: planItemId, action: "remove", who, before: row.before, after: null })
  } else {
    const p = row.payload as ItemValues
    // the rules are checked again: one may have been saved since it was proposed
    await checkItem(p, true)
    const fields = {
      kind: "allocation",
      purpose: p.purpose,
      title: p.title,
      detail: p.notes,
      notes: p.notes,
      amount: p.amount,
      every: p.every,
      category_id: p.categoryId,
      one_off_id: p.oneOffId,
      account_id: p.toAccountId,
      from_account_id: p.fromAccountId,
      from_member_id: p.fromMemberId,
      start_date: p.startDate,
      end_date: p.endDate,
      target: p.target,
      match_keys: p.matchKeys,
      updated_at: new Date().toISOString(),
    }
    if (planItemId) {
      const current = await planItem(planItemId)
      if (!current || current.removedAt) throw new Error(`Plan item ${planItemId} has been removed since this was proposed`)
      await must(db.from("plan_items").update(fields).eq("id", planItemId))
      await logChange({ entity: "plan_item", entityId: planItemId, action: "update", who, before: values(current), after: p })
    } else {
      const planId = await currentPlanId(row.madeBy)
      const last = await must<{ position: number }[]>(
        db.from("plan_items").select("position").eq("plan_id", planId).eq("kind", "allocation").order("position", { ascending: false }).limit(1)
      )
      const created = await must<{ id: number }>(
        db
          .from("plan_items")
          .insert({ ...fields, plan_id: planId, position: (last[0]?.position ?? -1) + 1 })
          .select("id")
          .single()
      )
      planItemId = created.id
      await logChange({ entity: "plan_item", entityId: planItemId, action: "create", who, before: null, after: p })
    }
    after = p
  }

  const decided = await must<PendingChange>(
    db
      .from("pending_plan_changes")
      .update({ status: "approved", decided_by: m.id, decided_at: new Date().toISOString(), plan_item_id: planItemId })
      .eq("id", id)
      .select(PENDING_COLUMNS)
      .single()
  )
  await logChange({
    entity: "pending",
    entityId: id,
    action: "approve",
    who: { askedBy: m.id, madeBy, reason: `Approved by ${m.name}: ${row.reason}` },
    before: row.before,
    after,
  })
  return { approved: await describePending(decided), planItemId }
}

/** Reject a pending change as the signed-in member. */
export async function rejectChange(id: number, memberId: string, reason: string, madeBy: ChangeMaker) {
  const why = needReason(reason)
  const row = await pendingRow(id)
  const m = await decider(row, memberId)
  const decided = await must<PendingChange>(
    (await getDb())
      .from("pending_plan_changes")
      .update({ status: "rejected", decided_by: m.id, decided_at: new Date().toISOString(), decision_reason: why })
      .eq("id", id)
      .select(PENDING_COLUMNS)
      .single()
  )
  await logChange({ entity: "pending", entityId: id, action: "reject", who: { askedBy: m.id, madeBy, reason: why }, before: row.before, after: row.payload })
  return { rejected: await describePending(decided) }
}

const CHANGE_COLUMNS =
  "id, entity, entityId:entity_id, action, askedBy:asked_by, madeBy:made_by, reason, before, after, createdAt:created_at"

type ChangeRow = {
  id: number
  entity: string
  entityId: number | null
  action: string
  askedBy: string | null
  madeBy: ChangeMaker
  reason: string
  before: unknown
  after: unknown
  createdAt: string
}

async function named(rows: ChangeRow[]) {
  const people = await getPeople()
  const name = new Map(people.map((p) => [p.id, p.name]))
  return rows.map((r) => ({ ...r, askedByName: r.askedBy === null ? null : (name.get(r.askedBy) ?? "Someone") }))
}

/** Every change to one plan item, oldest first, with the pending changes about it. */
export async function planHistory(id: number) {
  const db = await getDb()
  const [item, changes, pending] = await Promise.all([
    planItem(id),
    must<ChangeRow[]>(db.from("plan_changes").select(CHANGE_COLUMNS).eq("entity", "plan_item").eq("entity_id", id).order("id")),
    must<PendingChange[]>(db.from("pending_plan_changes").select(PENDING_COLUMNS).eq("plan_item_id", id).order("id")),
  ])
  if (!item) throw new Error(`Plan item ${id} not found`)
  return {
    item: { id: item.id, ...values(item), removedAt: item.removedAt, createdWithPlan: item.planId },
    changes: await named(changes),
    pending: await Promise.all(pending.map(describePending)),
  }
}

/** Every logged change since a date (or the last 30 days), newest first. */
export async function changeLog(since?: string | null) {
  const from = since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const rows = await must<ChangeRow[]>(
    (await getDb()).from("plan_changes").select(CHANGE_COLUMNS).gte("created_at", from).order("id", { ascending: false }).limit(200)
  )
  return { since: from, changes: await named(rows) }
}
