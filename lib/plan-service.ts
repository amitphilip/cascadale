import {
  FREQUENCIES,
  simulate,
  type AdjustmentKind,
  type AdjustmentTarget,
  type Frequency,
  type Plan,
  type PlanSnapshot,
} from "@/lib/plan"
import { endPosition } from "@/lib/plan-goal"
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
 * There's nothing to rebuild: the plan is worked out when it's read, as the last plan made
 * with the model carried over to today's data with your pots and adjustments on top
 * (livePlan). A write records an instruction and the plan has it from then on. Every write
 * is logged with who made it, when and why, and is idempotent on its operation id.
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

/** The last plan made with the model: the latest plan message and the snapshot it was made on. */
export type PlanRecord = {
  /** the plan message's id */
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
    // the write is in by now, so failing to report on it shouldn't undo the log of it
    const planNow = await planOutcome(deps).catch(() => null)
    const full = { ...result, appliedDecisions: decisions, planNow } as T
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

// ── The plan as it stands ────────────────────────────────────────────────────

/** A plan for a snapshot with these instructions applied, your adjustments in the snapshot. */
function assemble(
  snapshot: PlanSnapshot,
  base: { plan: Plan; snapshot: PlanSnapshot } | null,
  pots: PotInstruction[],
  adjustments: AdjustmentInstruction[]
) {
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
 * A plan for this snapshot with every instruction applied: the base plan's set-asides
 * (carried over from another snapshot when needed), your pots on top, your adjustments in
 * the snapshot.
 */
export async function withInstructions(
  repo: PlanRepo,
  snapshot: PlanSnapshot,
  base: { plan: Plan; snapshot: PlanSnapshot } | null
) {
  const [pots, adjustments] = await Promise.all([repo.listPots(), repo.listAdjustments()])
  return assemble(snapshot, base, pots, adjustments)
}

/**
 * The plan as it stands: today's data with every instruction applied. Nothing is saved, so
 * a set-aside whose income has gone is dropped with a warning and comes back if it returns.
 */
export async function livePlan(deps: Pick<PlanDeps, "repo" | "loadSnapshot">) {
  const [base, snapshot] = await Promise.all([deps.repo.latestPlan(), deps.loadSnapshot()])
  if (!base || !snapshot) return null
  return { base, ...(await withInstructions(deps.repo, snapshot, base)) }
}

/** The bills no pot covers, by name. */
export const uncoveredBills = (snap: PlanSnapshot, plan: Plan) =>
  simulate(snap, plan).uncovered.map((id) => snap.bills.find((b) => b.id === id)?.name ?? id)

/** What the plan now does, as a write reports it. */
async function planOutcome(deps: PlanDeps) {
  const live = await livePlan(deps)
  if (!live) return null
  const sim = simulate(live.snapshot, live.plan)
  return {
    monthly: sim.monthly,
    overdrafts: sim.overdrafts,
    uncoveredBills: uncoveredBills(live.snapshot, live.plan),
    warnings: live.plan.warnings,
    end: endPosition(live.snapshot, live.plan),
  }
}

export type PlanStatus = {
  status: "no_plan" | "current"
  /** Cas decisions that change the plan and haven't been carried out */
  unappliedDecisions: PlanDecision[]
}

/** Whether there's a plan, and the decisions still to carry out in it. */
export async function planStatus(
  deps: Pick<PlanDeps, "repo">,
  latest?: PlanRecord | null
): Promise<PlanStatus> {
  latest ??= await deps.repo.latestPlan()
  return {
    status: latest ? "current" : "no_plan",
    unappliedDecisions: await deps.repo.openDecisions(),
  }
}

/** Everything the Plan page and get_plan show about the plan's instructions. */
export async function getPlanState(deps: Pick<PlanDeps, "repo">) {
  const latest = await deps.repo.latestPlan()
  const [status, pots, adjustments, changes] = await Promise.all([
    planStatus(deps, latest),
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

/** A pot's fields from what was asked for, checked against the data. */
function resolvePot(snap: PlanSnapshot, input: PotInput) {
  const name = input.name.trim()
  if (!name) throw new Error("Give the pot a name")
  if (!(input.amount > 0)) throw new Error("The amount must be above zero")
  if (!FREQUENCIES.includes(input.frequency)) throw new Error(`Frequency is one of ${FREQUENCIES.join(", ")}`)
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
  return {
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
  }
}

/** Add a pot to the plan, or change the one with this name. */
export async function upsertPot(deps: PlanDeps, input: PotInput & WriteMeta) {
  return once(deps, "upsert_pot", input, async () => {
    const fields = resolvePot(await snapshotOrThrow(deps), input)
    const { name } = fields
    const existing = (await deps.repo.listPots()).find((p) => p.name.toLowerCase() === name.toLowerCase())
    const after = await deps.repo.savePot({
      id: existing?.id,
      ...fields,
      updatedBy: deps.actor,
      reason: input.reason?.trim() || null,
    })
    const before = existing && !existing.removed ? existing : null
    return {
      summary: `${before ? "Changed" : "Added"} pot ${name}: ${after.amount} ${after.frequency}`,
      result: { changed: { pot: { before, after } } },
    }
  })
}

/** Take a pot out of the plan, yours or one the planner made. */
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
      result: { changed: { pot: { before: existing && !existing.removed ? existing : inPlan, after: null } } },
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

/** An adjustment's fields from what was asked for, checked against the data. */
function resolveAdjustment(snap: PlanSnapshot, input: AdjustmentInput, potNames: string[]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Date is yyyy-MM-dd")
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
    const found = matchByName(potNames, name, (p) => p)
    if (found.length !== 1)
      throw new Error(`${found.length ? "Several pots" : "No pot"} match "${name}". Pots: ${potNames.join(", ") || "none"}`)
    ref = found[0]
    name = found[0]
  } else {
    if (input.kind !== "add") throw new Error("A transfer adjustment adds a transfer; use kind add")
    if (!from || !to || from.id === to.id) throw new Error("A transfer needs two different accounts: fromAccountId and toAccountId")
    name ||= `Transfer ${from.name} to ${to.name}`
  }
  return {
    date: input.date,
    kind: input.kind,
    target: input.target,
    ref,
    name,
    amount,
    fromAccountId: from?.id ?? null,
    toAccountId: to?.id ?? null,
  }
}

/** The pots a pot adjustment can name: the plan's and yours. */
async function potNames(repo: PlanRepo, latest: PlanRecord | null) {
  return [
    ...new Set([
      ...(latest?.plan.set_asides.map((s) => s.pot) ?? []),
      ...(await repo.listPots()).filter((p) => !p.removed).map((p) => p.name),
    ]),
  ]
}

export async function addAdjustment(deps: PlanDeps, input: AdjustmentInput & WriteMeta) {
  return once(deps, "add_plan_adjustment", input, async () => {
    const snap = await snapshotOrThrow(deps)
    const fields = resolveAdjustment(snap, input, await potNames(deps.repo, await deps.repo.latestPlan()))
    const after = await deps.repo.addAdjustment({
      ...fields,
      createdBy: deps.actor,
      reason: input.reason?.trim() || null,
    })
    const { kind, name, amount, date } = fields
    const what = kind === "skip" ? `Skip ${name}` : kind === "add" ? `Add ${amount} ${name}` : `${name} to ${amount}`
    return {
      summary: `${what} on ${date}`,
      result: { changed: { adjustment: { before: null, after } } },
    }
  })
}

export async function removeAdjustment(deps: PlanDeps, input: { adjustmentId: number } & WriteMeta) {
  return once(deps, "remove_plan_adjustment", input, async () => {
    const before = await deps.repo.removeAdjustment(input.adjustmentId, deps.actor, input.reason?.trim() || null)
    if (!before) throw new Error(`No adjustment ${input.adjustmentId} in effect; list_plan_adjustments shows them`)
    return {
      summary: `Removed adjustment: ${before.kind} ${before.name} on ${before.date}`,
      result: { changed: { adjustment: { before, after: null } } },
    }
  })
}

// ── Trying a change ──────────────────────────────────────────────────────────

export type PlanTrial = {
  pots?: PotInput[]
  removePots?: string[]
  adjustments?: AdjustmentInput[]
  /** what a bill would cost each time it's paid */
  bills?: { name: string; amount: number }[]
}

/** What a change would do to the plan, run the same way as the real one. Saves nothing. */
export async function tryPlanChange(deps: PlanDeps, trial: PlanTrial) {
  const [base, snapshot, pots, adjustments] = await Promise.all([
    deps.repo.latestPlan(),
    snapshotOrThrow(deps),
    deps.repo.listPots(),
    deps.repo.listAdjustments(),
  ])
  const stamp = { updatedBy: deps.actor, updatedAt: "", reason: null }
  const nextPots = new Map(pots.map((p) => [p.name.toLowerCase(), p]))
  for (const input of trial.pots ?? []) {
    const fields = resolvePot(snapshot, input)
    nextPots.set(fields.name.toLowerCase(), { id: 0, ...fields, ...stamp })
  }
  const names = await potNames(deps.repo, base)
  for (const raw of trial.removePots ?? []) {
    const found = matchByName([...names, ...[...nextPots.values()].map((p) => p.name)], raw, (p) => p)
    if (!found.length) throw new Error(`No pot named "${raw}". Pots: ${names.join(", ") || "none"}`)
    nextPots.set(found[0].toLowerCase(), {
      id: 0,
      name: found[0],
      amount: 0,
      frequency: "payday",
      fromAccountId: null,
      toAccountId: null,
      incomeKey: null,
      incomeName: null,
      covers: [],
      note: null,
      removed: true,
      ...stamp,
    })
  }
  const nextAdjustments = [
    ...adjustments,
    ...(trial.adjustments ?? []).map(
      (a, i): AdjustmentInstruction => ({
        id: -(i + 1),
        ...resolveAdjustment(snapshot, a, names),
        createdBy: deps.actor,
        createdAt: "",
        reason: null,
      })
    ),
  ]
  const costs = new Map(
    (trial.bills ?? []).map(({ name, amount }) => {
      const bill = snapshot.bills.find((b) => b.key === name) ?? findFlow(snapshot.bills, { name })
      if (!bill) throw new Error(`No single bill matches "${name}". Bills: ${billList(snapshot)}`)
      return [bill.id, amount]
    })
  )
  const changed: PlanSnapshot = {
    ...snapshot,
    bills: snapshot.bills.map((b) => {
      const amount = costs.get(b.id)
      return amount === undefined ? b : { ...b, amount, monthly: (b.monthly * amount) / b.amount }
    }),
  }

  const carried = base && { plan: base.plan, snapshot: base.snapshot }
  const before = assemble(snapshot, carried, pots, adjustments)
  const after = assemble(changed, carried, [...nextPots.values()], nextAdjustments)
  return {
    diff: diffPlans(before, after),
    end: { before: endPosition(before.snapshot, before.plan), after: endPosition(after.snapshot, after.plan) },
    overdrafts: simulate(after.snapshot, after.plan).overdrafts,
    uncoveredBills: uncoveredBills(after.snapshot, after.plan),
    warnings: after.plan.warnings,
  }
}
