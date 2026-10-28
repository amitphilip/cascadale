import {
  FORTNIGHTLY,
  MONTHLY,
  sanitizePlan,
  simulate,
  type AdjustmentKind,
  type AdjustmentTarget,
  type Frequency,
  type Plan,
  type PlanAdjustmentEvent,
  type PlanFlow,
  type PlanSnapshot,
} from "@/lib/plan"
import { similarity } from "@/lib/rules"

/**
 * Instructions you give the plan, from the website, Claude (MCP) or Cas: pots that must be
 * in it and one-off adjustments on given dates. They're stored on their own (plan_pots,
 * plan_adjustments) and applied every time the plan is built, whether by a rebuild or by
 * the planner chat, so neither can drop them. Pure functions.
 */

/** Who changed the plan. */
export const ACTORS = ["website", "mcp", "cas"] as const
export type Actor = (typeof ACTORS)[number]
export const ACTOR_LABELS: Record<Actor, string> = {
  website: "Website",
  mcp: "Claude",
  cas: "Cas",
}

/** A pot or set-aside you asked for. */
export type PotInstruction = {
  id: number
  name: string
  /** set aside each time it's funded */
  amount: number
  frequency: Frequency
  /** account the money is taken from; null for the funding income's account */
  fromAccountId: number | null
  /** account it moves to; null to earmark it in the from account */
  toAccountId: number | null
  /** the income that funds it (its series key), null for none in particular */
  incomeKey: string | null
  /** that income's name when it was set, for display and to find it again */
  incomeName: string | null
  /** series keys of the bills it pays */
  covers: string[]
  note: string | null
  /** a tombstone: take this pot out of the plan, even one the planner made */
  removed: boolean
  updatedBy: Actor
  updatedAt: string
  reason: string | null
}

/** A one-off change on one date. */
export type AdjustmentInstruction = {
  id: number
  date: string
  kind: AdjustmentKind
  target: AdjustmentTarget
  /** the bill's series key or the pot's name; null for a transfer */
  ref: string | null
  name: string
  amount: number | null
  fromAccountId: number | null
  toAccountId: number | null
  createdBy: Actor
  createdAt: string
  reason: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const norm = (s: string) => s.trim().toLowerCase()

/** Items whose name matches: exactly, then containing it, then by similar words. */
export function matchByName<T>(items: T[], name: string, nameOf: (t: T) => string) {
  const n = norm(name)
  const exact = items.filter((t) => norm(nameOf(t)) === n)
  if (exact.length) return exact
  const contains = items.filter((t) => norm(nameOf(t)).includes(n) || n.includes(norm(nameOf(t))))
  if (contains.length) return contains
  return items.filter((t) => similarity(norm(nameOf(t)), n) >= 0.6)
}

/** The flow a series key or name points at in a snapshot. */
export function findFlow(flows: PlanFlow[], ref: { key?: string | null; name?: string | null }) {
  if (ref.key) {
    const byKey = flows.find((f) => f.key === ref.key)
    if (byKey) return byKey
  }
  if (!ref.name) return undefined
  const found = matchByName(flows, ref.name, (f) => f.name)
  return found.length === 1 ? found[0] : undefined
}

export const emptyPlan = (): Plan => ({
  summary: "Built from your pots and adjustments.",
  set_asides: [],
  focus: [],
  warnings: [],
})

/** A pot's set-aside entry in a snapshot, or why it can't be placed. */
export function potSetAside(pot: PotInstruction, snap: PlanSnapshot) {
  const income = pot.incomeKey || pot.incomeName
    ? findFlow(snap.incomes, { key: pot.incomeKey, name: pot.incomeName })
    : undefined
  const warnings: string[] = []
  if ((pot.incomeKey || pot.incomeName) && !income)
    warnings.push(`Pot "${pot.name}": its income (${pot.incomeName ?? pot.incomeKey}) isn't in the data now`)

  // payday: the income's own payday; otherwise the income when it arrives that often
  let incomeId: string
  if (pot.frequency === "payday") incomeId = income?.id ?? MONTHLY
  else if (pot.frequency === "fortnightly")
    incomeId = income?.cadence === "fortnightly" ? income.id : FORTNIGHTLY
  else incomeId = income?.cadence === "monthly" ? income.id : MONTHLY

  const from = pot.fromAccountId ?? income?.accountId ?? null
  if (from === null) {
    warnings.push(`Pot "${pot.name}" has no account to take the money from`)
    return { entry: null, warnings }
  }
  const covers = pot.covers.flatMap((key) => {
    const bill = snap.bills.find((b) => b.key === key)
    return bill ? [bill.id] : []
  })
  return {
    entry: {
      pot: pot.name,
      income_id: incomeId,
      from_account_id: from,
      to_account_id: pot.toAccountId,
      amount: round2(pot.amount),
      covers,
      note: pot.note ?? (income ? `Set by you, from ${income.name}` : "Set by you"),
    } satisfies Plan["set_asides"][number],
    warnings,
  }
}

/**
 * The plan with your pots in it: each of your pots replaces the planner's entries with the
 * same name, removed pots go, and bills one of your pots covers leave every other pot.
 */
export function applyPots(plan: Plan, pots: PotInstruction[], snap: PlanSnapshot) {
  const ours = new Map(pots.map((p) => [norm(p.name), p]))
  const warnings: string[] = []
  const placed = pots.flatMap((p) => {
    if (p.removed) return []
    const { entry, warnings: w } = potSetAside(p, snap)
    warnings.push(...w)
    return entry ? [entry] : []
  })
  const claimed = new Set(placed.flatMap((e) => e.covers))
  const kept = plan.set_asides
    .filter((s) => !ours.has(norm(s.pot)))
    .map((s) => ({ ...s, covers: s.covers.filter((b) => !claimed.has(b)) }))
  const next = sanitizePlan({ ...plan, set_asides: [...kept, ...placed] }, snap)
  return { plan: { ...next, warnings: [...next.warnings, ...warnings] }, warnings }
}

/**
 * Carry a plan over to a newer snapshot: income and bill ids (I1, B2…) are positions, so
 * they're mapped through each flow's series key (or its name, on snapshots made before
 * keys). Set-asides whose income is gone are dropped and noted.
 */
export function remapPlan(plan: Plan, from: PlanSnapshot, to: PlanSnapshot) {
  const map = (fromFlows: PlanFlow[], toFlows: PlanFlow[]) =>
    new Map(
      fromFlows.flatMap((f) => {
        const t = findFlow(toFlows, { key: f.key, name: f.name })
        return t ? [[f.id, t.id] as const] : []
      })
    )
  const incomes = map(from.incomes, to.incomes)
  const bills = map(from.bills, to.bills)
  const dropped: string[] = []
  const setAsides = plan.set_asides.flatMap((s) => {
    const incomeId =
      s.income_id === MONTHLY || s.income_id === FORTNIGHTLY ? s.income_id : incomes.get(s.income_id)
    if (!incomeId) {
      dropped.push(s.pot)
      return []
    }
    return [{ ...s, income_id: incomeId, covers: s.covers.flatMap((b) => bills.get(b) ?? []) }]
  })
  return {
    ...plan,
    set_asides: setAsides,
    // carried-over warnings were about the old data
    warnings: dropped.length
      ? [`Dropped set-asides whose income stopped: ${[...new Set(dropped)].join(", ")}`]
      : [],
  }
}

/** Adjustments as the simulation takes them, with bill keys turned into this snapshot's ids. */
export function adjustmentEvents(adjustments: AdjustmentInstruction[], snap: PlanSnapshot) {
  const warnings: string[] = []
  const events = adjustments.flatMap((a): PlanAdjustmentEvent[] => {
    let ref = a.ref
    if (a.target === "bill") {
      const bill = findFlow(snap.bills, { key: a.ref, name: a.name })
      if (!bill) {
        warnings.push(`Adjustment "${a.name}" on ${a.date}: that bill isn't in the data now`)
        return []
      }
      ref = bill.id
    }
    return [
      {
        id: `A${a.id}`,
        date: a.date,
        kind: a.kind,
        target: a.target,
        ref,
        name: a.name,
        amount: a.amount,
        fromAccountId: a.fromAccountId,
        toAccountId: a.toAccountId,
      },
    ]
  })
  return { events, warnings }
}

export type PlanDiff = {
  pots: {
    added: { pot: string; monthly: number }[]
    removed: { pot: string; monthly: number }[]
    changed: { pot: string; monthlyBefore: number; monthlyAfter: number }[]
  }
  incomes: { added: string[]; removed: string[] }
  bills: { added: string[]; removed: string[] }
  adjustments: { added: string[]; removed: string[] }
  monthly: { before: Monthly | null; after: Monthly }
  overdrafts: { before: number; after: number }
  uncoveredBills: { before: number; after: number }
}
type Monthly = ReturnType<typeof simulate>["monthly"]

/** What changed between two built plans. */
export function diffPlans(
  before: { plan: Plan; snapshot: PlanSnapshot } | null,
  after: { plan: Plan; snapshot: PlanSnapshot }
): PlanDiff {
  const simAfter = simulate(after.snapshot, after.plan)
  const simBefore = before ? simulate(before.snapshot, before.plan) : null
  const pots = (sim: typeof simAfter | null) =>
    new Map((sim?.potSummaries ?? []).map((p) => [p.name, p.monthlyIn]))
  const a = pots(simAfter)
  const b = pots(simBefore)
  const names = (flows: PlanFlow[] | undefined) => new Set((flows ?? []).map((f) => f.key ?? f.name))
  const label = (flows: PlanFlow[], keys: string[]) =>
    keys.map((k) => flows.find((f) => (f.key ?? f.name) === k)?.name ?? k)
  const setDiff = (x: Set<string>, y: Set<string>) => [...x].filter((k) => !y.has(k))
  const adj = (s: PlanSnapshot | undefined) =>
    new Set((s?.adjustments ?? []).map((e) => `${e.date} ${e.kind} ${e.name}${e.amount !== null ? ` ${e.amount}` : ""}`))

  const incAfter = names(after.snapshot.incomes)
  const incBefore = names(before?.snapshot.incomes)
  const billAfter = names(after.snapshot.bills)
  const billBefore = names(before?.snapshot.bills)
  return {
    pots: {
      added: [...a].filter(([p]) => !b.has(p)).map(([pot, monthly]) => ({ pot, monthly })),
      removed: [...b].filter(([p]) => !a.has(p)).map(([pot, monthly]) => ({ pot, monthly })),
      changed: [...a]
        .filter(([p, m]) => b.has(p) && Math.abs(b.get(p)! - m) >= 0.01)
        .map(([pot, m]) => ({ pot, monthlyBefore: b.get(pot)!, monthlyAfter: m })),
    },
    incomes: {
      added: label(after.snapshot.incomes, setDiff(incAfter, incBefore)),
      removed: before ? label(before.snapshot.incomes, setDiff(incBefore, incAfter)) : [],
    },
    bills: {
      added: label(after.snapshot.bills, setDiff(billAfter, billBefore)),
      removed: before ? label(before.snapshot.bills, setDiff(billBefore, billAfter)) : [],
    },
    adjustments: {
      added: setDiff(adj(after.snapshot), adj(before?.snapshot)),
      removed: setDiff(adj(before?.snapshot), adj(after.snapshot)),
    },
    monthly: { before: simBefore?.monthly ?? null, after: simAfter.monthly },
    overdrafts: { before: simBefore?.overdrafts.length ?? 0, after: simAfter.overdrafts.length },
    uncoveredBills: { before: simBefore?.uncovered.length ?? 0, after: simAfter.uncovered.length },
  }
}
