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
import { endPosition } from "@/lib/plan-goal"
import { DEFAULT_MONEY, formatMoney } from "@/lib/format"
import {
  POT_TYPES,
  RESET_MODES,
  potFund,
  potHealth,
  potLedger,
  scheduledContributions,
  type PotEntry,
  type PotEntryKind,
  type PotLedger,
  type PotType,
  type ResetMode,
} from "@/lib/pots"
import { todayLocal } from "@/supabase/functions/_shared/akahu"
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

  /** Every sinking fund entry, with its linked transaction as it is now. */
  listPotEntries(): Promise<PotEntry[]>
  addPotEntry(e: Omit<PotEntry, "id" | "createdAt" | "transaction">): Promise<PotEntry>
  removePotEntry(id: number): Promise<PotEntry | null>
  /** One transaction, to link it to a fund. */
  getTransaction(id: number): Promise<{
    id: number
    date: string
    description: string
    amount: number
    accountId: number
    category: string | null
  } | null>

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
  /** today's date in the household's time zone; defaults to todayLocal() */
  today?: () => string
}

const todayOf = (deps: Pick<PlanDeps, "today">) => deps.today?.() ?? todayLocal()
const moneyIn = (snap: PlanSnapshot) => (n: number) =>
  formatMoney(n, { currency: snap.currency, locale: DEFAULT_MONEY.locale })

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

async function snapshotOrThrow(deps: Pick<PlanDeps, "loadSnapshot">) {
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

/** Each live sinking fund's ledger as of today. */
export function sinkingFundLedgers(
  snap: PlanSnapshot,
  pots: PotInstruction[],
  entries: PotEntry[],
  adjustments: AdjustmentInstruction[],
  today: string
): PotLedger[] {
  return pots
    .filter((p) => p.type === "sinking_fund" && !p.removed)
    .map((pot) => potLedger({ pot, entries, snap, adjustments, today, money: moneyIn(snap) }))
}

/**
 * A plan for a snapshot with these instructions applied: your adjustments and sinking funds
 * (balances and planned draws) in the snapshot, their warnings in the plan's.
 */
function assemble(
  snapshot: PlanSnapshot,
  base: { plan: Plan; snapshot: PlanSnapshot } | null,
  pots: PotInstruction[],
  adjustments: AdjustmentInstruction[],
  entries: PotEntry[],
  today: string
) {
  const { events, warnings: adjWarnings } = adjustmentEvents(adjustments, snapshot)
  const ledgers = sinkingFundLedgers(snapshot, pots, entries, adjustments, today)
  const snap: PlanSnapshot = { ...snapshot, adjustments: events, potFunds: ledgers.map(potFund) }
  const carried = !base ? emptyPlan() : base.snapshot === snapshot ? base.plan : remapPlan(base.plan, base.snapshot, snap)
  const { plan } = applyPots(carried, pots, snap)
  return {
    snapshot: snap,
    plan: { ...plan, warnings: [...plan.warnings, ...adjWarnings, ...ledgers.flatMap((l) => l.warnings)] },
    pots: pots.filter((p) => !p.removed),
    ledgers,
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
  base: { plan: Plan; snapshot: PlanSnapshot } | null,
  today = todayLocal()
) {
  const [pots, adjustments, entries] = await Promise.all([
    repo.listPots(),
    repo.listAdjustments(),
    repo.listPotEntries(),
  ])
  return assemble(snapshot, base, pots, adjustments, entries, today)
}

/**
 * The plan as it stands: today's data with every instruction applied. Nothing is saved, so
 * a set-aside whose income has gone is dropped with a warning and comes back if it returns.
 */
export async function livePlan(deps: Pick<PlanDeps, "repo" | "loadSnapshot" | "today">) {
  const [base, snapshot] = await Promise.all([deps.repo.latestPlan(), deps.loadSnapshot()])
  if (!base || !snapshot) return null
  return { base, ...(await withInstructions(deps.repo, snapshot, base, todayOf(deps))) }
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
    sinkingFunds: live.ledgers.map(potHealth),
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
  /** set_aside (the default for a new pot) or sinking_fund; omitted keeps the pot's type */
  type?: PotType
  /** set aside each time; a sinking fund can have 0 until you pick an amount */
  amount: number
  frequency: Frequency
  fromAccountId?: number | null
  toAccountId?: number | null
  /** the funding income: its key, or a name it contains (e.g. "Wood Partners") */
  income?: string | null
  /** bills it pays: keys or names */
  covers?: string[]
  note?: string | null
  /** sinking funds: the most it pays out per cycle; null for none, omitted keeps it */
  cap?: number | null
  /** sinking funds: the last day, yyyy-MM-dd or yyyy-MM (that month's last day); null for open-ended */
  endDate?: string | null
  /** sinking funds: reset totals and cap every year on this date; null for none */
  resetDate?: string | null
  /** sinking funds: at a reset, carry the balance over (default) or release it */
  resetMode?: ResetMode
  /** sinking funds: count scheduled contributions from this date; defaults to today for a new fund */
  startDate?: string | null
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
/** yyyy-MM-dd as is; yyyy-MM as that month's last day. */
function endOfDate(value: string, what: string) {
  if (ISO_DAY.test(value)) return value
  const m = value.match(/^(\d{4})-(\d{2})$/)
  if (!m) throw new Error(`${what} is yyyy-MM-dd or yyyy-MM`)
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate()
  return `${value}-${String(last).padStart(2, "0")}`
}
function isoDay(value: string, what: string) {
  if (!ISO_DAY.test(value)) throw new Error(`${what} is yyyy-MM-dd`)
  return value
}

/** The sinking fund fields from what was asked for, the existing pot's where not given. */
function resolveFund(input: PotInput, existing: PotInstruction | undefined, today: string) {
  const keep = existing && !existing.removed ? existing : undefined
  const type: PotType = input.type ?? keep?.type ?? "set_aside"
  if (!POT_TYPES.includes(type)) throw new Error(`Type is one of ${POT_TYPES.join(", ")}`)
  if (type !== "sinking_fund") {
    if (input.cap != null || input.endDate != null || input.resetDate != null)
      throw new Error("A cap, end date or reset date is for a sinking fund: pass type sinking_fund")
    return { type, capAmount: null, endDate: null, resetDate: null, resetMode: "carry" as ResetMode, scheduledFrom: null }
  }
  const capAmount = input.cap === undefined ? (keep?.capAmount ?? null) : input.cap
  if (capAmount !== null && !(capAmount > 0)) throw new Error("The cap must be above zero")
  const endDate =
    input.endDate === undefined ? (keep?.endDate ?? null) : input.endDate && endOfDate(input.endDate, "End date")
  const resetDate =
    input.resetDate === undefined ? (keep?.resetDate ?? null) : input.resetDate && isoDay(input.resetDate, "Reset date")
  const resetMode = input.resetMode ?? keep?.resetMode ?? "carry"
  if (!RESET_MODES.includes(resetMode)) throw new Error(`Reset mode is one of ${RESET_MODES.join(", ")}`)
  const scheduledFrom = input.startDate
    ? isoDay(input.startDate, "Start date")
    : keep?.type === "sinking_fund"
      ? (keep.scheduledFrom ?? today)
      : today
  return {
    type,
    capAmount: capAmount === null ? null : Math.round(capAmount * 100) / 100,
    endDate: endDate || null,
    resetDate: resetDate || null,
    resetMode,
    scheduledFrom,
  }
}

/** A pot's fields from what was asked for, checked against the data. */
function resolvePot(snap: PlanSnapshot, input: PotInput, sinking = false) {
  const name = input.name.trim()
  if (!name) throw new Error("Give the pot a name")
  if (sinking ? !(input.amount >= 0) : !(input.amount > 0))
    throw new Error(sinking ? "The amount can't be below zero" : "The amount must be above zero")
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
  if (input.fromAccountId == null && !income && input.amount > 0)
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
    const snap = await snapshotOrThrow(deps)
    const today = todayOf(deps)
    const existing = (await deps.repo.listPots()).find(
      (p) => p.name.toLowerCase() === input.name.trim().toLowerCase()
    )
    const fund = resolveFund(input, existing, today)
    const fields = resolvePot(snap, input, fund.type === "sinking_fund")
    const { name } = fields
    const before = existing && !existing.removed ? existing : null

    // a fund's schedule changing: freeze the contributions made so far under the old one
    let frozen = 0
    if (before?.type === "sinking_fund" && fund.type === "sinking_fund" && !input.startDate) {
      const changed =
        before.amount !== fields.amount ||
        before.frequency !== fields.frequency ||
        before.incomeKey !== fields.incomeKey ||
        before.incomeName !== fields.incomeName
      if (changed && before.scheduledFrom && before.scheduledFrom <= today) {
        const made = scheduledContributions(before, snap, await deps.repo.listAdjustments(), before.scheduledFrom, today)
        for (const c of made)
          await deps.repo.addPotEntry({
            potId: before.id,
            kind: "contribution",
            amount: c.amount,
            date: c.date,
            transactionId: null,
            note: "Scheduled",
            scheduled: true,
            createdBy: deps.actor,
          })
        frozen = made.length
        fund.scheduledFrom = toIsoDay(addDaysIso(today, 1))
      }
    }

    const after = await deps.repo.savePot({
      id: existing?.id,
      ...fields,
      ...fund,
      updatedBy: deps.actor,
      reason: input.reason?.trim() || null,
    })
    const kind = after.type === "sinking_fund" ? "sinking fund" : "pot"
    const cap = after.capAmount !== null ? `, cap ${after.capAmount}` : ""
    const end = after.endDate ? ` to ${after.endDate}` : after.resetDate ? `, resets yearly on ${after.resetDate.slice(5)}` : ""
    return {
      summary: `${before ? "Changed" : "Added"} ${kind} ${name}: ${after.amount} ${after.frequency}${cap}${end}`,
      result: {
        changed: { pot: { before, after } },
        ...(frozen ? { frozenContributions: frozen } : {}),
        ...(after.type === "sinking_fund" ? { ledger: await ledgerSummary(deps, after.name) } : {}),
      },
    }
  })
}

const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000)
const toIsoDay = (d: Date) => d.toISOString().slice(0, 10)

// ── Sinking funds ────────────────────────────────────────────────────────────

/** Every live sinking fund's ledger, as of today. */
export async function potLedgers(deps: Pick<PlanDeps, "repo" | "loadSnapshot" | "today">) {
  const [snap, pots, entries, adjustments] = await Promise.all([
    snapshotOrThrow(deps),
    deps.repo.listPots(),
    deps.repo.listPotEntries(),
    deps.repo.listAdjustments(),
  ])
  return { snapshot: snap, ledgers: sinkingFundLedgers(snap, pots, entries, adjustments, todayOf(deps)) }
}

/** The live sinking fund a name points at. */
async function sinkingFund(repo: PlanRepo, name: string) {
  const funds = (await repo.listPots()).filter((p) => p.type === "sinking_fund" && !p.removed)
  const found = matchByName(funds, name.trim(), (p) => p.name)
  if (found.length !== 1)
    throw new Error(
      `${found.length ? "Several sinking funds" : "No sinking fund"} match "${name}". Sinking funds: ${funds.map((p) => p.name).join(", ") || "none; add one with upsert_pot and type sinking_fund"}`
    )
  return found[0]
}

/** One fund's ledger. */
export async function potLedgerFor(deps: Pick<PlanDeps, "repo" | "loadSnapshot" | "today">, name: string) {
  const pot = await sinkingFund(deps.repo, name)
  const { ledgers } = await potLedgers(deps)
  return ledgers.find((l) => l.pot.id === pot.id)!
}

/** What a fund write reports about the fund afterwards. */
async function ledgerSummary(deps: PlanDeps, name: string) {
  const l = await potLedgerFor(deps, name)
  return {
    balance: l.balance,
    contributed: l.contributed,
    spent: l.spent,
    cap: l.cap,
    plannedTotal: l.plannedTotal,
    nextDraw: l.nextDraw,
    suggestion: l.suggestion,
    warnings: l.warnings,
  }
}

/**
 * Pay for a transaction from a fund (a draw), or count it as money into it (a contribution,
 * e.g. the transfer into its savings account). A draw leaves its category's budget but keeps
 * its category. plannedDrawId ticks off the planned draw it was for.
 */
export async function linkTransactionToPot(
  deps: PlanDeps,
  input: { pot: string; transactionId: number; kind?: "draw" | "contribution"; plannedDrawId?: number; note?: string | null } & WriteMeta
) {
  return once(deps, "link_transaction_to_pot", input, async () => {
    const pot = await sinkingFund(deps.repo, input.pot)
    const tx = await deps.repo.getTransaction(input.transactionId)
    if (!tx) throw new Error(`No transaction ${input.transactionId}; search_transactions finds them`)
    const entries = await deps.repo.listPotEntries()
    const linked = entries.find((e) => e.transactionId === tx.id)
    if (linked) {
      const other = (await deps.repo.listPots()).find((p) => p.id === linked.potId)
      throw new Error(`Transaction ${tx.id} is already linked to ${other?.name ?? "another fund"}; unlink it first`)
    }
    const kind = input.kind ?? (tx.amount < 0 ? "draw" : "contribution")
    let planned: PotEntry | undefined
    if (input.plannedDrawId) {
      planned = entries.find((e) => e.id === input.plannedDrawId && e.kind === "planned_draw" && e.potId === pot.id)
      if (!planned) throw new Error(`No planned draw ${input.plannedDrawId} on ${pot.name}; get_pot_ledger lists them`)
    }
    const entry = await deps.repo.addPotEntry({
      potId: pot.id,
      kind,
      amount: Math.abs(tx.amount),
      date: tx.date,
      transactionId: tx.id,
      note: input.note?.trim() || planned?.note || null,
      scheduled: false,
      createdBy: deps.actor,
    })
    if (planned) await deps.repo.removePotEntry(planned.id)
    return {
      summary: `Linked ${tx.description} (${tx.amount}) to ${pot.name} as a ${kind}`,
      result: {
        changed: { entry: { before: null, after: entry } },
        transaction: tx,
        ...(planned ? { plannedDrawDone: planned } : {}),
        ledger: await ledgerSummary(deps, pot.name),
      },
    }
  })
}

export async function unlinkTransactionFromPot(deps: PlanDeps, input: { transactionId: number } & WriteMeta) {
  return once(deps, "unlink_transaction_from_pot", input, async () => {
    const entry = (await deps.repo.listPotEntries()).find((e) => e.transactionId === input.transactionId)
    if (!entry) throw new Error(`Transaction ${input.transactionId} isn't linked to a fund`)
    await deps.repo.removePotEntry(entry.id)
    const pot = (await deps.repo.listPots()).find((p) => p.id === entry.potId)
    return {
      summary: `Unlinked transaction ${input.transactionId} from ${pot?.name ?? "its fund"}`,
      result: {
        changed: { entry: { before: entry, after: null } },
        ...(pot && pot.type === "sinking_fund" && !pot.removed ? { ledger: await ledgerSummary(deps, pot.name) } : {}),
      },
    }
  })
}

/** Add an expected one-off to a fund (kind planned_draw), or a top-up into it (kind contribution). */
export async function addPotEntry(
  deps: PlanDeps,
  input: { pot: string; kind: Extract<PotEntryKind, "planned_draw" | "contribution">; name?: string | null; amount: number; date: string } & WriteMeta
) {
  const action = input.kind === "planned_draw" ? "add_pot_planned_draw" : "add_pot_contribution"
  return once(deps, action, input, async () => {
    const pot = await sinkingFund(deps.repo, input.pot)
    if (!(input.amount > 0)) throw new Error("Give an amount above zero")
    const date = isoDay(input.date, "Date")
    const name = input.name?.trim() || null
    if (input.kind === "planned_draw" && !name) throw new Error("Name the planned draw, e.g. Air tickets")
    const entry = await deps.repo.addPotEntry({
      potId: pot.id,
      kind: input.kind,
      amount: Math.round(input.amount * 100) / 100,
      date,
      transactionId: null,
      note: name,
      scheduled: false,
      createdBy: deps.actor,
    })
    return {
      summary:
        input.kind === "planned_draw"
          ? `Planned ${name} of ${entry.amount} on ${date} from ${pot.name}`
          : `Topped up ${pot.name} by ${entry.amount} on ${date}`,
      result: { changed: { entry: { before: null, after: entry } }, ledger: await ledgerSummary(deps, pot.name) },
    }
  })
}

/** Remove a planned draw or a top-up by its entry id. Linked transactions are unlinked instead. */
export async function removePotEntry(
  deps: PlanDeps,
  input: { entryId: number; kind?: PotEntryKind } & WriteMeta
) {
  const action = input.kind === "planned_draw" ? "remove_pot_planned_draw" : "remove_pot_entry"
  return once(deps, action, input, async () => {
    const entry = (await deps.repo.listPotEntries()).find((e) => e.id === input.entryId)
    if (!entry || (input.kind && entry.kind !== input.kind))
      throw new Error(`No ${input.kind === "planned_draw" ? "planned draw" : "fund entry"} ${input.entryId}; get_pot_ledger lists them`)
    if (entry.transactionId) throw new Error("That entry is a linked transaction: unlink it with unlink_transaction_from_pot")
    await deps.repo.removePotEntry(entry.id)
    const pot = (await deps.repo.listPots()).find((p) => p.id === entry.potId)
    return {
      summary: `Removed ${entry.kind === "planned_draw" ? "planned draw" : entry.kind} ${entry.note ?? ""} ${entry.amount} on ${entry.date} from ${pot?.name ?? "its fund"}`.replace(/\s+/g, " "),
      result: {
        changed: { entry: { before: entry, after: null } },
        ...(pot && pot.type === "sinking_fund" && !pot.removed ? { ledger: await ledgerSummary(deps, pot.name) } : {}),
      },
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
      type: existing?.type ?? "set_aside",
      capAmount: existing?.capAmount ?? null,
      endDate: existing?.endDate ?? null,
      resetDate: existing?.resetDate ?? null,
      resetMode: existing?.resetMode ?? "carry",
      scheduledFrom: existing?.scheduledFrom ?? null,
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

/** What a purchase does to a fund: run as one more planned draw on its ledger. */
async function purchaseFromPot(
  deps: Pick<PlanDeps, "repo" | "loadSnapshot">,
  name: string,
  input: PurchaseInput,
  date: string,
  today: string
) {
  const [snap, pots, entries, adjustments] = await Promise.all([
    snapshotOrThrow(deps),
    deps.repo.listPots(),
    deps.repo.listPotEntries(),
    deps.repo.listAdjustments(),
  ])
  const pot = pots.find((p) => p.name === name)!
  const ledger = (extra: PotEntry[]) =>
    potLedger({ pot, entries: [...entries, ...extra], snap, adjustments, today, money: moneyIn(snap) })
  const before = ledger([])
  const after = ledger([
    {
      id: -1,
      potId: pot.id,
      kind: "planned_draw",
      amount: input.amount,
      date,
      transactionId: null,
      note: input.name,
      scheduled: false,
      createdBy: "mcp",
      createdAt: "",
      transaction: null,
    },
  ])
  const draw = after.plannedDraws.find((d) => d.entryId === -1)!
  const overCap = !!after.cap && after.cap.remainingAfterPlanned < -0.005
  const short = draw.balanceAfter < -0.005
  return {
    pot: pot.name,
    fits: !overCap && !short,
    balanceBefore: before.balance,
    /** the fund's balance after it, with contributions due by its date and earlier planned draws */
    balanceAfter: draw.balanceAfter,
    capRemainingBefore: before.cap?.remainingAfterPlanned ?? null,
    capRemainingAfter: after.cap?.remainingAfterPlanned ?? null,
    overCap,
    short: short ? round2(-draw.balanceAfter) : 0,
    warnings: after.warnings.filter((w) => !before.warnings.includes(w)),
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

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
  const [base, snapshot, pots, adjustments, entries] = await Promise.all([
    deps.repo.latestPlan(),
    snapshotOrThrow(deps),
    deps.repo.listPots(),
    deps.repo.listAdjustments(),
    deps.repo.listPotEntries(),
  ])
  const today = todayOf(deps)
  const stamp = { updatedBy: deps.actor, updatedAt: "", reason: null }
  const nextPots = new Map(pots.map((p) => [p.name.toLowerCase(), p]))
  for (const input of trial.pots ?? []) {
    const existing = nextPots.get(input.name.trim().toLowerCase())
    const fund = resolveFund(input, existing, today)
    const fields = resolvePot(snapshot, input, fund.type === "sinking_fund")
    // a fund keeps its id, so its ledger carries over
    nextPots.set(fields.name.toLowerCase(), { id: existing?.id ?? 0, ...fields, ...fund, ...stamp })
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
      type: "set_aside",
      capAmount: null,
      endDate: null,
      resetDate: null,
      resetMode: "carry",
      scheduledFrom: null,
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
  const before = assemble(snapshot, carried, pots, adjustments, entries, today)
  const after = assemble(changed, carried, [...nextPots.values()], nextAdjustments, entries, today)
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
  /** a sinking fund to pay it from instead: tested against its balance and cap, not the category */
  pot?: string
}

export type PurchaseVerdict = "yes" | "over_budget" | "over_pot" | "wait" | "no"

/**
 * Can you buy this? Runs the purchase through the plan as a one-off on its date and says
 * whether every bill and set-aside still gets paid (spare cash stays at or above zero),
 * what it does to the category's month and to where the plan ends, and if not now, the
 * first payday it would fit. Saves nothing.
 */
export async function checkPurchase(
  deps: Pick<PlanDeps, "repo" | "loadSnapshot" | "today">,
  input: PurchaseInput,
  spend: CategorySpend[] | null,
  today: string
) {
  const live = await livePlan({ ...deps, today: () => today })
  if (!live) throw new Error("There's no plan yet")
  const { snapshot, plan } = live
  const date = !input.date || input.date < snapshot.start ? snapshot.start : input.date
  const account = accountOf(snapshot, input.accountId, "account")
  const fund = input.pot?.trim() ? await sinkingFund(deps.repo, input.pot) : null
  const before = simulate(snapshot, plan)
  const spareBefore = spareCash(snapshot, before)
  // from a fund it's one of the fund's draws; otherwise a one-off from the account
  const buying = (on: string): PlanSnapshot =>
    fund
      ? {
          ...snapshot,
          potFunds: (snapshot.potFunds ?? []).map((f) =>
            f.pot === fund.name
              ? { ...f, draws: [...f.draws, { id: "P1", name: input.name, date: on, amount: input.amount }] }
              : f
          ),
        }
      : {
          ...snapshot,
          upcoming: [
            ...(snapshot.upcoming ?? []),
            { id: "P1", name: input.name, date: on, amount: input.amount, accountId: account?.id ?? null },
          ],
        }
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

  const potCheck = fund ? await purchaseFromPot(deps, fund.name, input, date, today) : null
  // a fund pays it, so the category's month doesn't
  const budget = input.category && !fund
    ? monthBudget(categoryCosts(snapshot), spend ?? [], today).lines.find(
        (l) => l.category.toLowerCase() === input.category!.trim().toLowerCase()
      ) ?? null
    : null
  const budgetLeftAfter = budget && Math.round((budget.left - input.amount) * 100) / 100
  const verdict: PurchaseVerdict =
    earliest === now
      ? potCheck && !potCheck.fits
        ? "over_pot"
        : budgetLeftAfter !== null && budgetLeftAfter < 0
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
    pot: potCheck,
    leftOverPerMonth: before.monthly.free,
    end: { before: endPosition(snapshot, plan), after: endPosition(now.snap, plan) },
    newOverdrafts: newOverdrafts.map((o) => ({ account: name(o.accountId), date: o.date, lowest: o.lowest })),
  }
}
