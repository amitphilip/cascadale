import {
  FREQUENCIES,
  simulate,
  type AdjustmentKind,
  type AdjustmentTarget,
  type Frequency,
  type Plan,
  type PlanSnapshot,
} from "@/lib/plan"
import {
  categoryCosts,
  monthBudget,
  spareCash,
  type CategorySpend,
} from "@/lib/plan-budget"
import { resolveAccountId, type AccountRef } from "@/lib/account-lookup"
import type { PlanAction } from "@/lib/db/schema"
import type { DataHealth } from "@/lib/health"
import { endPosition } from "@/lib/plan-goal"
import { goalFor, planFigures, type Tx } from "@/lib/plan-figures"
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
  /** what the change touched, before and after */
  before?: unknown
  after?: unknown
  proposalId?: number | null
  transactionId?: number | null
}

/** What a change links to: the proposal it carries out, the transaction that prompted it. */
export type ChangeLinks = { proposalId?: number | null; transactionId?: number | null }

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

export type NewPlanAction = Pick<PlanAction, "title" | "detail" | "dueDate" | "focusTitle" | "createdBy"> &
  Pick<PlanAction, "amount" | "fromAccountId" | "toAccountId">

/** A decision Cas noted that changes the plan, not yet applied to it. */
export type PlanDecision = { id: number; content: string; createdAt: string }

export interface PlanRepo {
  /** Start a write: a new change row, or the existing one for this operation id. */
  claim(c: { operationId: string; actor: Actor; action: string; reason: string | null } & ChangeLinks): Promise<{
    change: PlanChange
    existing: boolean
  }>
  complete(id: number, summary: string, result: unknown, diff: { before: unknown; after: unknown }): Promise<void>
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
  /** the latest plan you started yourself, which sets the goal */
  goalPlan(): Promise<PlanRecord | null>

  listActions(includeDone: boolean): Promise<PlanAction[]>
  addAction(a: NewPlanAction): Promise<PlanAction>
  /** null when there's no such action */
  setActionDone(id: number, done: boolean, by: { actor: Actor; transactionId: number | null }): Promise<PlanAction | null>
  removeAction(id: number): Promise<PlanAction | null>

  openDecisions(): Promise<PlanDecision[]>
  applyDecisions(ids: number[], changeId: number): Promise<PlanDecision[]>
}

export type PlanDeps = {
  repo: PlanRepo
  /** today's snapshot, built the same way the Plan page builds it */
  loadSnapshot: () => Promise<PlanSnapshot | null>
  actor: Actor
  /** told of every new change once it's recorded (not replays); emits plan/changed */
  onChange?: (change: PlanChange) => Promise<void>
  /** accounts with their aliases and purpose, to find one by what people call it */
  accounts?: () => Promise<AccountRef[]>
}

/** Accounts named in words rather than ids. */
export type AccountNames = { fromAccount?: string | null; toAccount?: string | null }

/**
 * An input with fromAccount / toAccount (a name, alias or purpose, e.g. "rates account")
 * turned into ids; an id given alongside wins. Throws with the candidates when it's unclear.
 */
export async function withAccountIds<T extends AccountNames & { fromAccountId?: number | null; toAccountId?: number | null }>(
  deps: Pick<PlanDeps, "accounts" | "loadSnapshot">,
  input: T
): Promise<T> {
  if (!input.fromAccount?.trim() && !input.toAccount?.trim()) return input
  const list = deps.accounts ? await deps.accounts() : ((await deps.loadSnapshot())?.accounts ?? [])
  const out = { ...input }
  if (out.fromAccountId == null && input.fromAccount?.trim())
    out.fromAccountId = resolveAccountId(list, input.fromAccount, "From account")
  if (out.toAccountId == null && input.toAccount?.trim())
    out.toAccountId = resolveAccountId(list, input.toAccount, "To account")
  return out
}

/** A write's common inputs. */
export type WriteMeta = ChangeLinks & {
  /** any unique string; the same id again returns the first result and changes nothing */
  operationId: string
  reason?: string | null
  /** Cas decisions this change carries out */
  decisionIds?: number[]
}

/** The before and after of what a write's result says it changed. */
function diffOf(result: object) {
  const changed = (result as { changed?: Record<string, { before?: unknown; after?: unknown }> }).changed
  const first = changed && Object.values(changed)[0]
  return { before: first?.before ?? null, after: first?.after ?? null }
}

/**
 * Record a change and run its write once per operation id (see once). For writes outside the
 * plan's own tables, such as a recategorisation Cas proposed and you approved.
 */
export function recordChange<T extends object>(
  deps: PlanDeps,
  action: string,
  meta: WriteMeta,
  fn: () => Promise<{ summary: string; result: T }>
) {
  return once(deps, action, meta, fn)
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
    proposalId: meta.proposalId ?? null,
    transactionId: meta.transactionId ?? null,
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
    await deps.repo.complete(change.id, summary, full, diffOf(result))
    // a failed event only delays Cas's next run; it mustn't fail the write
    await deps.onChange?.({ ...change, summary, completedAt: new Date().toISOString() }).catch((err) =>
      console.error("plan/changed not sent", err)
    )
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
export async function upsertPot(deps: PlanDeps, raw: PotInput & AccountNames & WriteMeta) {
  const input = await withAccountIds(deps, raw)
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

export async function addAdjustment(deps: PlanDeps, raw: AdjustmentInput & AccountNames & WriteMeta) {
  const input = await withAccountIds(deps, raw)
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
  pots?: (PotInput & AccountNames)[]
  removePots?: string[]
  adjustments?: (AdjustmentInput & AccountNames)[]
  /** what a bill would cost each time it's paid */
  bills?: { name: string; amount: number }[]
}

/** What a change would do to the plan, run the same way as the real one. Saves nothing. */
export async function tryPlanChange(deps: PlanDeps, raw: PlanTrial) {
  const trial: PlanTrial = {
    ...raw,
    pots: raw.pots && (await Promise.all(raw.pots.map((p) => withAccountIds(deps, p)))),
    adjustments: raw.adjustments && (await Promise.all(raw.adjustments.map((a) => withAccountIds(deps, a)))),
  }
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

export type PurchaseInput = {
  name: string
  amount: number
  /** when you'd buy it; defaults to the plan's first day */
  date?: string
  /** the account it's paid from; defaults to the cash account with the most in it */
  accountId?: number
  /** the expense category it would count against */
  category?: string
}

export type PurchaseVerdict = "yes" | "over_budget" | "wait" | "no"

/**
 * Can you buy this? Runs the purchase through the plan as a one-off on its date and says
 * whether every bill and set-aside still gets paid (spare cash stays at or above zero),
 * what it does to the category's month and to where the plan ends, and if not now, the
 * first payday it would fit. Saves nothing.
 */
export async function checkPurchase(
  deps: Pick<PlanDeps, "repo" | "loadSnapshot">,
  input: PurchaseInput,
  spend: CategorySpend[] | null,
  today: string
) {
  const live = await livePlan(deps)
  if (!live) throw new Error("There's no plan yet")
  const { snapshot, plan } = live
  const date = !input.date || input.date < snapshot.start ? snapshot.start : input.date
  const account = accountOf(snapshot, input.accountId, "account")
  const before = simulate(snapshot, plan)
  const spareBefore = spareCash(snapshot, before)
  const buying = (on: string): PlanSnapshot => ({
    ...snapshot,
    upcoming: [
      ...(snapshot.upcoming ?? []),
      { id: "P1", name: input.name, date: on, amount: input.amount, accountId: account?.id ?? null },
    ],
  })
  const tryOn = (on: string) => {
    const snap = buying(on)
    const sim = simulate(snap, plan)
    return { date: on, snap, sim, spare: spareCash(snap, sim) }
  }
  const fits = (t: ReturnType<typeof tryOn>) => (t.spare?.balance ?? -Infinity) >= 0

  const now = tryOn(date)
  let earliest = fits(now) ? now : null
  if (!earliest) {
    const paydays = [
      ...new Set(before.events.filter((e) => e.kind === "income" && e.date > date).map((e) => e.date)),
    ]
    for (const day of paydays) {
      const t = tryOn(day)
      if (fits(t)) {
        earliest = t
        break
      }
    }
  }

  const budget = input.category
    ? monthBudget(categoryCosts(snapshot), spend ?? [], today).lines.find(
        (l) => l.category.toLowerCase() === input.category!.trim().toLowerCase()
      ) ?? null
    : null
  const budgetLeftAfter = budget && Math.round((budget.left - input.amount) * 100) / 100
  const verdict: PurchaseVerdict =
    earliest === now
      ? budgetLeftAfter !== null && budgetLeftAfter < 0
        ? "over_budget"
        : "yes"
      : earliest
        ? "wait"
        : "no"
  const newOverdrafts = now.sim.overdrafts.filter((o) => {
    const was = before.overdrafts.find((b) => b.accountId === o.accountId)
    return !was || o.lowest < was.lowest - 0.5
  })
  const name = (id: number) => snapshot.accounts.find((a) => a.id === id)?.name ?? `#${id}`

  return {
    verdict,
    purchase: { name: input.name, amount: input.amount, date, account: account?.name ?? null },
    spareCash: {
      before: spareBefore?.balance ?? null,
      after: now.spare?.balance ?? null,
      lowestOn: now.spare?.date ?? null,
    },
    earliestDate: earliest?.date ?? null,
    budget: budget && {
      category: budget.category,
      limit: budget.limit,
      limitIs: budget.fromBudget ? "budget" : "plan",
      spentThisMonth: budget.spent,
      leftBefore: budget.left,
      leftAfter: budgetLeftAfter,
    },
    leftOverPerMonth: before.monthly.free,
    end: { before: endPosition(snapshot, plan), after: endPosition(now.snap, plan) },
    newOverdrafts: newOverdrafts.map((o) => ({ account: name(o.accountId), date: o.date, lowest: o.lowest })),
  }
}

// ── Action items ─────────────────────────────────────────────────────────────

export type PlanActionInput = {
  title: string
  detail?: string | null
  dueDate?: string | null
  /** the plan's focus item it came from */
  focusTitle?: string | null
  /** for an item that moves money: with an account, a sync can tick it off */
  amount?: number | null
  fromAccountId?: number | null
  toAccountId?: number | null
}

/** A write's meta where the operation id may be left out: one is made up, so it runs once. */
export type OptionalMeta = Omit<WriteMeta, "operationId"> & { operationId?: string }
const withId = <T extends OptionalMeta>(input: T): T & WriteMeta => ({
  ...input,
  operationId: input.operationId?.trim() || crypto.randomUUID(),
})

/** Put an action item on the Plan page. A title that's already open returns that item. */
export async function addPlanAction(deps: PlanDeps, raw: PlanActionInput & AccountNames & OptionalMeta) {
  const input = await withAccountIds(deps, raw)
  const title = input.title.trim()
  if (!title) throw new Error("Describe the action")
  if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new Error("Due date is yyyy-MM-dd")
  if (input.amount != null && !(input.amount > 0)) throw new Error("The amount must be above zero")
  if ((input.fromAccountId != null || input.toAccountId != null) && input.fromAccountId === input.toAccountId)
    throw new Error("A transfer needs two different accounts")
  const same = (await deps.repo.listActions(false)).find((a) => a.title.toLowerCase() === title.toLowerCase())
  if (same) return { id: same.id, existing: true }
  return once(deps, "add_plan_action", withId(input), async () => {
    const after = await deps.repo.addAction({
      title,
      detail: input.detail?.trim() || null,
      dueDate: input.dueDate || null,
      focusTitle: input.focusTitle?.trim() || null,
      createdBy: deps.actor,
      amount: input.amount ?? null,
      fromAccountId: input.fromAccountId ?? null,
      toAccountId: input.toAccountId ?? null,
    })
    return {
      summary: `Added action: ${title}`,
      result: { id: after.id, changed: { action: { before: null, after } } },
    }
  })
}

export async function setPlanActionDone(
  deps: PlanDeps,
  input: { actionId: number; done: boolean } & OptionalMeta
) {
  return once(deps, "set_plan_action_done", withId(input), async () => {
    const before = (await deps.repo.listActions(true)).find((a) => a.id === input.actionId)
    if (!before) throw new Error(`No action ${input.actionId}; list_plan_actions shows them`)
    const after = await deps.repo.setActionDone(input.actionId, input.done, {
      actor: deps.actor,
      transactionId: input.done ? (input.transactionId ?? null) : null,
    })
    return {
      summary: `${input.done ? "Done" : "Reopened"}: ${before.title}`,
      result: { changed: { action: { before, after } } },
    }
  })
}

export async function removePlanAction(deps: PlanDeps, input: { actionId: number } & OptionalMeta) {
  return once(deps, "remove_plan_action", withId(input), async () => {
    const before = await deps.repo.removeAction(input.actionId)
    if (!before) throw new Error(`No action ${input.actionId}; list_plan_actions shows them`)
    return {
      summary: `Removed action: ${before.title}`,
      result: { changed: { action: { before, after: null } } },
    }
  })
}

// ── Figures ──────────────────────────────────────────────────────────────────

/** What the figures need beyond the plan: today's balances and every transaction. */
export type FigureSource = {
  balances: () => Promise<Map<number, number>>
  txs: () => Promise<Tx[]>
  health: () => Promise<DataHealth | null>
}

/** The plan's headline numbers as they stand today (see lib/plan-figures.ts). */
export async function loadFigures(deps: Pick<PlanDeps, "repo" | "loadSnapshot">, source: FigureSource, today: string) {
  const [live, started, balances, txs, health, actions] = await Promise.all([
    livePlan(deps),
    deps.repo.goalPlan(),
    source.balances(),
    source.txs(),
    source.health(),
    deps.repo.listActions(false),
  ])
  if (!live) return null
  const goal = goalFor({
    started: started && { snapshot: started.snapshot, plan: started.plan },
    base: { snapshot: live.base.snapshot, plan: live.base.plan },
    live,
    balances,
    txs,
    today,
  })
  return planFigures({ live, goal, health, actions, today })
}
