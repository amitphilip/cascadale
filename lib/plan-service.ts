import {
  FREQUENCIES,
  planDataContext,
  simulate,
  type AdjustmentKind,
  type AdjustmentTarget,
  type Frequency,
  type Plan,
  type PlanSnapshot,
} from "@/lib/plan"
import {
  adjustmentEvents,
  applyPots,
  diffPlans,
  emptyPlan,
  findFlow,
  matchByName,
  remapPlan,
  type Actor,
  type AdjustmentInstruction,
  type PotInstruction,
} from "@/lib/plan-instructions"

/**
 * The plan's one service. The Plan page, its server actions and the MCP tools (Claude
 * through Cascadale, and Cas) all read and change the plan through these functions, over
 * a PlanRepo (lib/plan-repo.ts for the database, an in-memory one in the tests), so there
 * is a single copy of the logic.
 *
 * Writes record an instruction (a pot or an adjustment) and leave the built plan alone:
 * the plan is then out of date until it's rebuilt, from the website or with
 * regenerate_plan. That way several changes go in one rebuild with one diff, and nothing
 * rebuilds the plan behind the back of someone looking at it. Every write is logged with
 * who made it, when and why, and is idempotent on its operation id.
 */

export type PlanChange = {
  id: number
  operationId: string
  actor: Actor
  action: string
  reason: string | null
  summary: string | null
  result: unknown
  createdAt: string
  completedAt: string | null
}

/** A built plan: the latest plan message and the snapshot it was built on. */
export type PlanRecord = {
  /** the plan message's id; pass it as expectedPlanId to rebuild only this plan */
  id: number
  threadId: number
  createdAt: string
  madeBy: Actor | null
  snapshot: PlanSnapshot
  plan: Plan
}

/** A decision Cas noted that changes the plan, not yet applied to it. */
export type PlanDecision = { id: number; content: string; createdAt: string }

export interface PlanRepo {
  /** Start a write: a new change row, or the existing one for this operation id. */
  claim(c: { operationId: string; actor: Actor; action: string; reason: string | null }): Promise<{
    change: PlanChange
    existing: boolean
  }>
  complete(id: number, summary: string, result: unknown): Promise<void>
  /** Drop a change whose write failed, so the operation id can be retried. */
  release(id: number): Promise<void>
  listChanges(limit: number): Promise<PlanChange[]>

  listPots(): Promise<PotInstruction[]>
  savePot(pot: Omit<PotInstruction, "id" | "updatedAt"> & { id?: number }): Promise<PotInstruction>

  /** Adjustments still in effect. */
  listAdjustments(): Promise<AdjustmentInstruction[]>
  addAdjustment(a: Omit<AdjustmentInstruction, "id" | "createdAt">): Promise<AdjustmentInstruction>
  removeAdjustment(id: number, by: Actor, reason: string | null): Promise<AdjustmentInstruction | null>

  latestPlan(): Promise<PlanRecord | null>
  savePlan(p: {
    snapshot: PlanSnapshot
    plan: Plan
    madeBy: Actor
    request: string
    context: string
    reply: string
  }): Promise<PlanRecord>

  openDecisions(): Promise<PlanDecision[]>
  applyDecisions(ids: number[], changeId: number): Promise<PlanDecision[]>
}

export type PlanDeps = {
  repo: PlanRepo
  /** today's snapshot, built the same way the Plan page builds it */
  loadSnapshot: () => Promise<PlanSnapshot | null>
  actor: Actor
}

/** A write's common inputs. */
export type WriteMeta = {
  /** any unique string; the same id again returns the first result and changes nothing */
  operationId: string
  reason?: string | null
  /** Cas decisions this change carries out */
  decisionIds?: number[]
}

/** Actions that change an instruction (and so leave the built plan out of date). */
const INSTRUCTION_ACTIONS = new Set([
  "upsert_pot",
  "remove_pot",
  "add_plan_adjustment",
  "remove_plan_adjustment",
])

export class PlanConflictError extends Error {}

/**
 * Run a write once per operation id: a repeat returns the stored result with replayed set.
 * The change row is claimed first, so two concurrent calls with one id can't both write.
 */
async function once<T extends object>(
  deps: PlanDeps,
  action: string,
  meta: WriteMeta,
  fn: () => Promise<{ summary: string; result: T }>
): Promise<T & { change: ChangeRef; replayed: boolean }> {
  const operationId = meta.operationId.trim()
  if (!operationId) throw new Error("Pass an operationId: any unique string for this change")
  const { change, existing } = await deps.repo.claim({
    operationId,
    actor: deps.actor,
    action,
    reason: meta.reason?.trim() || null,
  })
  if (existing) {
    if (change.action !== action)
      throw new Error(`Operation ${operationId} was already used for ${change.action}`)
    if (change.completedAt === null)
      throw new Error(`Operation ${operationId} is still running; try again shortly`)
    return { ...(change.result as T), change: changeRef(change), replayed: true }
  }
  try {
    const { summary, result } = await fn()
    const decisions = meta.decisionIds?.length
      ? await deps.repo.applyDecisions(meta.decisionIds, change.id)
      : []
    const full = { ...result, appliedDecisions: decisions } as T
    await deps.repo.complete(change.id, summary, full)
    return {
      ...full,
      change: changeRef({ ...change, summary, completedAt: new Date().toISOString() }),
      replayed: false,
    }
  } catch (err) {
    await deps.repo.release(change.id)
    throw err
  }
}

type ChangeRef = { id: number; actor: Actor; at: string; reason: string | null; summary: string | null }
const changeRef = (c: PlanChange): ChangeRef => ({
  id: c.id,
  actor: c.actor,
  at: c.createdAt,
  reason: c.reason,
  summary: c.summary,
})

async function snapshotOrThrow(deps: PlanDeps) {
  const snap = await deps.loadSnapshot()
  if (!snap) throw new Error("Import some transactions first")
  return snap
}

function accountOf(snap: PlanSnapshot, id: number | null | undefined, what: string) {
  if (id == null) return null
  const a = snap.accounts.find((x) => x.id === id)
  if (!a) throw new Error(`${what}: no account ${id}. Accounts: ${accountList(snap)}`)
  return a
}
const accountList = (snap: PlanSnapshot) => snap.accounts.map((a) => `${a.id} ${a.name}`).join(", ")
const incomeList = (snap: PlanSnapshot) =>
  snap.incomes.map((i) => `"${i.name}" (${i.cadence}, key ${i.key})`).join("; ") || "none"
const billList = (snap: PlanSnapshot) =>
  snap.bills.map((b) => `"${b.name}" (key ${b.key})`).join("; ") || "none"

// ── Status ───────────────────────────────────────────────────────────────────

export type PlanStatus = {
  status: "no_plan" | "current" | "out_of_date"
  /** why it's out of date, in words */
  reasons: string[]
  /** instruction changes made since the plan was built */
  pendingChanges: { id: number; actor: Actor; action: string; summary: string | null; at: string; reason: string | null }[]
  /** Cas decisions that change the plan and aren't in it yet */
  unappliedDecisions: PlanDecision[]
}

/** Whether the built plan has every instruction and decision in it. */
export async function planStatus(
  deps: Pick<PlanDeps, "repo">,
  latest?: PlanRecord | null,
  extraReasons: string[] = []
): Promise<PlanStatus> {
  latest ??= await deps.repo.latestPlan()
  const [changes, decisions] = await Promise.all([
    deps.repo.listChanges(100),
    deps.repo.openDecisions(),
  ])
  // timestamps compared as times: Postgres trims trailing zeros off fractional seconds
  const builtAt = latest ? Date.parse(latest.createdAt) : -Infinity
  const pending = changes.filter(
    (c) => INSTRUCTION_ACTIONS.has(c.action) && c.completedAt !== null && Date.parse(c.createdAt) > builtAt
  )
  const reasons = [
    ...(pending.length ? [`${pending.length} plan ${pending.length === 1 ? "change" : "changes"} not applied`] : []),
    ...(decisions.length
      ? [`${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"} not applied`]
      : []),
    ...extraReasons,
  ]
  return {
    status: !latest ? "no_plan" : reasons.length ? "out_of_date" : "current",
    reasons,
    pendingChanges: pending.map((c) => ({
      id: c.id,
      actor: c.actor,
      action: c.action,
      summary: c.summary,
      at: c.createdAt,
      reason: c.reason,
    })),
    unappliedDecisions: decisions,
  }
}

/** Everything the Plan page and get_plan show about the plan's instructions. */
export async function getPlanState(deps: Pick<PlanDeps, "repo">, extraReasons: string[] = []) {
  const latest = await deps.repo.latestPlan()
  const [status, pots, adjustments, changes] = await Promise.all([
    planStatus(deps, latest, extraReasons),
    deps.repo.listPots(),
    deps.repo.listAdjustments(),
    deps.repo.listChanges(20),
  ])
  return {
    plan: latest,
    ...status,
    pots: pots.filter((p) => !p.removed),
    removedPots: pots.filter((p) => p.removed),
    adjustments,
    recentChanges: changes.filter((c) => c.completedAt !== null),
  }
}

// ── Pots ─────────────────────────────────────────────────────────────────────

export type PotInput = {
  name: string
  amount: number
  frequency: Frequency
  fromAccountId?: number | null
  toAccountId?: number | null
  /** the funding income: its key, or a name it contains (e.g. "Wood Partners") */
  income?: string | null
  /** bills it pays: keys or names */
  covers?: string[]
  note?: string | null
}

/** Add a pot to the plan, or change the one with this name. Applied on the next rebuild. */
export async function upsertPot(deps: PlanDeps, input: PotInput & WriteMeta) {
  return once(deps, "upsert_pot", input, async () => {
    const name = input.name.trim()
    if (!name) throw new Error("Give the pot a name")
    if (!(input.amount > 0)) throw new Error("The amount must be above zero")
    if (!FREQUENCIES.includes(input.frequency)) throw new Error(`Frequency is one of ${FREQUENCIES.join(", ")}`)
    const snap = await snapshotOrThrow(deps)
    accountOf(snap, input.fromAccountId, "From account")
    accountOf(snap, input.toAccountId, "To account")

    let income = null
    if (input.income?.trim()) {
      const ref = input.income.trim()
      const byKey = snap.incomes.find((i) => i.key === ref)
      const found = byKey ? [byKey] : matchByName(snap.incomes, ref, (i) => i.name)
      if (found.length !== 1)
        throw new Error(
          `${found.length ? "Several incomes" : "No income"} match "${ref}". Pass one of these keys: ${incomeList(snap)}`
        )
      income = found[0]
    }
    if (input.fromAccountId == null && !income)
      throw new Error("Say which account the money comes from (fromAccountId) or which income funds it")
    const covers = (input.covers ?? []).map((ref) => {
      const bill = snap.bills.find((b) => b.key === ref) ?? findFlow(snap.bills, { name: ref })
      if (!bill?.key) throw new Error(`No single bill matches "${ref}". Bills: ${billList(snap)}`)
      return bill.key
    })

    const existing = (await deps.repo.listPots()).find((p) => p.name.toLowerCase() === name.toLowerCase())
    const after = await deps.repo.savePot({
      id: existing?.id,
      name,
      amount: Math.round(input.amount * 100) / 100,
      frequency: input.frequency,
      fromAccountId: input.fromAccountId ?? null,
      toAccountId: input.toAccountId ?? null,
      incomeKey: income?.key ?? null,
      incomeName: income?.name ?? null,
      covers,
      note: input.note?.trim() || null,
      removed: false,
      updatedBy: deps.actor,
      reason: input.reason?.trim() || null,
    })
    const before = existing && !existing.removed ? existing : null
    return {
      summary: `${before ? "Changed" : "Added"} pot ${name}: ${after.amount} ${after.frequency}`,
      result: {
        changed: { pot: { before, after } },
        nextStep: "Rebuild the plan (regenerate_plan) to apply it.",
      },
    }
  })
}

/** Take a pot out of the plan, yours or one the planner made. Applied on the next rebuild. */
export async function removePot(deps: PlanDeps, input: { name: string } & WriteMeta) {
  return once(deps, "remove_pot", input, async () => {
    const name = input.name.trim()
    const pots = await deps.repo.listPots()
    const existing = pots.find((p) => p.name.toLowerCase() === name.toLowerCase())
    const latest = await deps.repo.latestPlan()
    const inPlan = latest?.plan.set_asides.find((s) => s.pot.toLowerCase() === name.toLowerCase())
    if (!inPlan && (!existing || existing.removed)) {
      const names = [
        ...new Set([...(latest?.plan.set_asides.map((s) => s.pot) ?? []), ...pots.filter((p) => !p.removed).map((p) => p.name)]),
      ]
      throw new Error(`No pot named "${name}". Pots: ${names.join(", ") || "none"}`)
    }
    const after = await deps.repo.savePot({
      id: existing?.id,
      name: existing?.name ?? inPlan!.pot,
      amount: existing?.amount ?? inPlan!.amount,
      frequency: existing?.frequency ?? "payday",
      fromAccountId: existing?.fromAccountId ?? inPlan?.from_account_id ?? null,
      toAccountId: existing?.toAccountId ?? inPlan?.to_account_id ?? null,
      incomeKey: existing?.incomeKey ?? null,
      incomeName: existing?.incomeName ?? null,
      covers: existing?.covers ?? [],
      note: existing?.note ?? null,
      removed: true,
      updatedBy: deps.actor,
      reason: input.reason?.trim() || null,
    })
    return {
      summary: `Removed pot ${after.name}`,
      result: {
        changed: { pot: { before: existing && !existing.removed ? existing : inPlan, after: null } },
        nextStep: "Rebuild the plan (regenerate_plan) to apply it.",
      },
    }
  })
}

// ── Adjustments ──────────────────────────────────────────────────────────────

export type AdjustmentInput = {
  date: string
  kind: AdjustmentKind
  target: AdjustmentTarget
  /** the bill (key or name) or pot (name); for a transfer, a label */
  name?: string | null
  amount?: number | null
  fromAccountId?: number | null
  toAccountId?: number | null
}

export async function addAdjustment(deps: PlanDeps, input: AdjustmentInput & WriteMeta) {
  return once(deps, "add_plan_adjustment", input, async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Date is yyyy-MM-dd")
    const snap = await snapshotOrThrow(deps)
    if (input.date < snap.start) throw new Error(`The plan starts on ${snap.start}; pick a date from then on`)
    const amount = input.amount ?? null
    if (input.kind === "skip" && amount !== null) throw new Error("A skip has no amount")
    if (input.kind !== "skip" && !(amount !== null && amount > 0)) throw new Error("Give an amount above zero")
    const from = accountOf(snap, input.fromAccountId, "From account")
    const to = accountOf(snap, input.toAccountId, "To account")

    let ref: string | null = null
    let name = input.name?.trim() ?? ""
    if (input.target === "bill") {
      if (!name) throw new Error(`Name the bill. Bills: ${billList(snap)}`)
      const bill = snap.bills.find((b) => b.key === name) ?? findFlow(snap.bills, { name })
      if (!bill?.key) throw new Error(`No single bill matches "${name}". Bills: ${billList(snap)}`)
      ref = bill.key
      name = bill.name
    } else if (input.target === "pot") {
      const latest = await deps.repo.latestPlan()
      const pots = [
        ...new Set([
          ...(latest?.plan.set_asides.map((s) => s.pot) ?? []),
          ...(await deps.repo.listPots()).filter((p) => !p.removed).map((p) => p.name),
        ]),
      ]
      const found = matchByName(pots, name, (p) => p)
      if (found.length !== 1)
        throw new Error(`${found.length ? "Several pots" : "No pot"} match "${name}". Pots: ${pots.join(", ") || "none"}`)
      ref = found[0]
      name = found[0]
    } else {
      if (input.kind !== "add") throw new Error("A transfer adjustment adds a transfer; use kind add")
      if (!from || !to || from.id === to.id) throw new Error("A transfer needs two different accounts: fromAccountId and toAccountId")
      name ||= `Transfer ${from.name} to ${to.name}`
    }
    const after = await deps.repo.addAdjustment({
      date: input.date,
      kind: input.kind,
      target: input.target,
      ref,
      name,
      amount,
      fromAccountId: from?.id ?? null,
      toAccountId: to?.id ?? null,
      createdBy: deps.actor,
      reason: input.reason?.trim() || null,
    })
    const what = input.kind === "skip" ? `Skip ${name}` : input.kind === "add" ? `Add ${amount} ${name}` : `${name} to ${amount}`
    return {
      summary: `${what} on ${input.date}`,
      result: {
        changed: { adjustment: { before: null, after } },
        nextStep: "Rebuild the plan (regenerate_plan) to apply it.",
      },
    }
  })
}

export async function removeAdjustment(deps: PlanDeps, input: { adjustmentId: number } & WriteMeta) {
  return once(deps, "remove_plan_adjustment", input, async () => {
    const before = await deps.repo.removeAdjustment(input.adjustmentId, deps.actor, input.reason?.trim() || null)
    if (!before) throw new Error(`No adjustment ${input.adjustmentId} in effect; list_plan_adjustments shows them`)
    return {
      summary: `Removed adjustment: ${before.kind} ${before.name} on ${before.date}`,
      result: {
        changed: { adjustment: { before, after: null } },
        nextStep: "Rebuild the plan (regenerate_plan) to apply it.",
      },
    }
  })
}

// ── Building the plan ────────────────────────────────────────────────────────

/**
 * A plan for this snapshot with every instruction applied: the base plan's set-asides
 * (carried over from another snapshot when needed), your pots on top, your adjustments
 * frozen into the snapshot.
 */
export async function withInstructions(
  repo: PlanRepo,
  snapshot: PlanSnapshot,
  base: { plan: Plan; snapshot: PlanSnapshot } | null
) {
  const [pots, adjustments] = await Promise.all([repo.listPots(), repo.listAdjustments()])
  const { events, warnings: adjWarnings } = adjustmentEvents(adjustments, snapshot)
  const snap: PlanSnapshot = { ...snapshot, adjustments: events }
  const carried = !base ? emptyPlan() : base.snapshot === snapshot ? base.plan : remapPlan(base.plan, base.snapshot, snap)
  const { plan } = applyPots(carried, pots, snap)
  return {
    snapshot: snap,
    plan: { ...plan, warnings: [...plan.warnings, ...adjWarnings] },
    pots: pots.filter((p) => !p.removed),
  }
}

/**
 * Rebuild the plan from today's data with every pot and adjustment applied, keeping the
 * current plan's other set-asides. Doesn't ask the model, so it's quick and gives the
 * same plan for the same data. Pass expectedPlanId to rebuild only if nobody else has
 * changed the plan since you read it.
 */
export async function regeneratePlan(
  deps: PlanDeps,
  input: WriteMeta & { expectedPlanId?: number | null }
) {
  return once(deps, "regenerate_plan", input, async () => {
    const fresh = await snapshotOrThrow(deps)
    const previous = await deps.repo.latestPlan()
    if (input.expectedPlanId != null && previous?.id !== input.expectedPlanId)
      throw new PlanConflictError(
        `The plan changed since you read it (now ${previous?.id ?? "none"}, expected ${input.expectedPlanId}). Read it again with get_plan.`
      )
    const statusBefore = await planStatus(deps, previous)
    const built = await withInstructions(deps.repo, fresh, previous)
    const potNames = built.pots.map((p) => p.name)
    const saved = await deps.repo.savePlan({
      snapshot: built.snapshot,
      plan: built.plan,
      madeBy: deps.actor,
      request: input.reason?.trim() || "Rebuild the plan from my latest data, pots and adjustments.",
      context:
        planDataContext(built.snapshot) +
        (potNames.length ? `\n\nKeep my pots ${potNames.join(", ")} as they are unless I ask.` : ""),
      reply: `Rebuilt from your data to ${built.snapshot.dataEnd}${
        potNames.length ? `, with your pots (${potNames.join(", ")})` : ""
      }${built.snapshot.adjustments?.length ? ` and ${built.snapshot.adjustments.length} one-off adjustments` : ""}.`,
    })
    const diff = diffPlans(previous, { plan: saved.plan, snapshot: saved.snapshot })
    const sim = simulate(saved.snapshot, saved.plan)
    return {
      summary: `Rebuilt the plan (${statusBefore.pendingChanges.length} changes applied)`,
      result: {
        planId: saved.id,
        madeAt: saved.createdAt,
        plan: saved.plan,
        adjustments: saved.snapshot.adjustments ?? [],
        monthly: sim.monthly,
        overdrafts: sim.overdrafts,
        uncoveredBills: sim.uncovered,
        applied: statusBefore.pendingChanges,
        diff,
      },
    }
  })
}
