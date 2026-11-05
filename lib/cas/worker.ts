import { format, subDays, parseISO } from "date-fns"

import { matchable, matchActions, type MatchTx } from "@/lib/action-matching"
import type { DataHealth } from "@/lib/health"
import type { PlanFigures } from "@/lib/plan-figures"
import { PERSON_ACTORS } from "@/lib/plan-instructions"
import {
  loadFigures,
  setPlanActionDone,
  type FigureSource,
  type PlanChange,
  type PlanDeps,
} from "@/lib/plan-service"

import type { Judge, Judgement } from "./judge"
import type { CasSnapshot, CasStore, NewProposal, Proposal, SnapshotWarning, TopAction } from "./store"

/**
 * Cas as a background worker: after a sync or a plan change it works out the figures,
 * asks a model for its judgement on them once, and writes a snapshot (cas_snapshots) that
 * get_status serves without a model. lib/cas/run.ts wires it to the database and Inngest.
 */

/** How far back a person's change counts as a decision Cas mustn't undo. */
export const DECISION_DAYS = 30

export type WorkerDeps = {
  /** the plan service acting as cas, quiet (its own writes don't re-trigger it) */
  plan: PlanDeps
  store: CasStore
  source: FigureSource
  /** null when there's no Anthropic key: the figures speak alone */
  judge: Judge | null
  model: string
  today: string
  /** why a proposed call couldn't run (lib/cas/proposals.ts), so it's dropped; none checks nothing */
  validate?: (tool: string, args: Record<string, unknown>) => string | null
  /** the plan service acting as system, quiet, and transactions from a date on: to tick off finished items */
  system?: PlanDeps
  transactions?: (since: string) => Promise<MatchTx[]>
}

/**
 * Tick off action items the transactions show are done, before anything else, so the
 * snapshot never reports finished work as overdue. A clear match is ticked off as system
 * with the transaction linked; several possible ones become a proposal.
 */
export async function autoComplete(deps: WorkerDeps) {
  const { system, transactions, store, today } = deps
  if (!system || !transactions) return { ticked: [] as number[], proposed: [] as number[] }
  const all = await system.repo.listActions(true)
  const open = all.filter(matchable)
  const pendingSystem = (await store.listProposals(["pending"])).filter((p) => p.source === "system")
  // a possible match for an item that's since been done or removed is moot
  const openIds = new Set(all.filter((a) => a.doneAt === null).map((a) => a.id))
  for (const p of pendingSystem)
    if (!openIds.has(Number(p.args.actionId)))
      await store.settleProposal(p.id, { status: "superseded", reason: "The action item is done or gone" })
  if (!open.length) return { ticked: [], proposed: [] }

  const earliest = open.map((a) => a.createdAt.slice(0, 10)).sort()[0]
  const since = format(subDays(parseISO(earliest), 3), "yyyy-MM-dd")
  const txs = await transactions(since)
  const byId = new Map(txs.map((t) => [t.id, t]))
  const ticked: number[] = []
  const proposed: number[] = []
  for (const m of matchActions(all, txs, today)) {
    const action = all.find((a) => a.id === m.actionId)!
    if (m.kind === "confident") {
      const t = byId.get(m.transactionId)!
      await setPlanActionDone(system, {
        actionId: m.actionId,
        done: true,
        operationId: `match-${m.actionId}-${m.transactionId}`,
        reason: `Matched ${t.description} (${t.amount}) on ${t.date}`,
        transactionId: m.transactionId,
      })
      ticked.push(m.actionId)
    } else if (!pendingSystem.some((p) => Number(p.args.actionId) === m.actionId && p.status === "pending")) {
      const list = m.candidates.map((t) => `${t.description} ${t.amount} on ${t.date}`).join("; ")
      const [p] = await store.addProposals([
        {
          tool: "set_plan_action_done",
          args: { actionId: m.actionId, done: true },
          reason: `"${action.title}" may be done, but it isn't clear which transaction did it: ${list}`.slice(0, 500),
          source: "system",
          basedOnChangeId: null,
          basedOnSyncAt: null,
        },
      ])
      proposed.push(p.id)
    }
  }
  return { ticked, proposed }
}

export type RawProposal = { tool: string; args: Record<string, unknown>; reason: string }

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

/** Data health and the figures as the snapshot's warnings. */
export function snapshotWarnings(health: DataHealth | null, figures: PlanFigures | null, uncategorised: number) {
  const out: SnapshotWarning[] = []
  for (const a of health?.accounts ?? [])
    if (a.stale) out.push({ kind: "stale_feed", message: `${a.name} is stale: ${a.staleReason}` })
  for (const d of health?.drift ?? [])
    out.push({
      kind: "drift",
      message: `${d.account} is ${money(d.difference ?? 0)} ${(d.difference ?? 0) < 0 ? "below" : "above"} the bank${d.explainedByPending ? ", explained by pending transactions" : ""}`,
    })
  for (const b of health?.seriesToConfirm ?? [])
    out.push({ kind: "series", message: `"${b.ended.example}" may have been replaced by "${b.candidate.example}"` })
  if (uncategorised > 0)
    out.push({ kind: "uncategorised", message: `${uncategorised} transactions aren't categorised` })
  for (const o of figures?.overdrafts ?? [])
    out.push({ kind: "overdraft", message: `${o.account} goes below zero on ${o.date}, down to -${money(o.lowest)}` })
  return out
}

/** A headline from the figures alone, for when no model runs. */
export function plainHeadline(figures: PlanFigures | null) {
  if (!figures) return "There's no plan yet: make one on the Plan page."
  const overdue = figures.actions.filter((a) => a.status === "overdue").length
  const gap = figures.goal?.gap
  const lead =
    gap === undefined || gap === null
      ? figures.status === "off_track"
        ? "Off track"
        : "On track"
      : gap >= 0
        ? `On track: ${money(gap)} ahead of the goal`
        : `${money(gap)} short of the goal`
  const low = figures.lowPoint ? `, lowest ${money(figures.lowPoint.amount)} on ${figures.lowPoint.date}` : ""
  return `${lead}${low}${overdue ? `; ${overdue} overdue action${overdue === 1 ? "" : "s"}` : ""}.`
}

/** What a tool call (or a recorded change) is about, so a proposal can be matched to a decision. */
export function targetOf(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case "upsert_pot":
    case "remove_pot":
      return typeof args.name === "string" ? `pot:${args.name.trim().toLowerCase()}` : null
    case "remove_plan_adjustment":
      return `adjustment:${args.adjustmentId}`
    case "set_plan_action_done":
    case "remove_plan_action":
      return `action:${args.actionId}`
    case "set_category_budgets":
      return null
    default:
      return null
  }
}

function changeTargets(c: PlanChange): string[] {
  const rows = [c.after, c.before].filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
  return rows.flatMap((r) => {
    if (c.action.endsWith("_pot") && typeof r.name === "string") return [`pot:${r.name.toLowerCase()}`]
    if (c.action.includes("adjustment") && r.id !== undefined) return [`adjustment:${r.id}`]
    if (c.action.includes("plan_action") && r.id !== undefined) return [`action:${r.id}`]
    return []
  })
}

/**
 * Split proposals into ones to keep and ones that would touch something a person decided
 * recently; those become notes, so Cas raises its disagreement instead of undoing it.
 */
export function respectDecisions(proposals: RawProposal[], decisions: PlanChange[]) {
  const decided = new Map<string, PlanChange>()
  for (const d of decisions) for (const t of changeTargets(d)) if (!decided.has(t)) decided.set(t, d)
  const kept: RawProposal[] = []
  const notes: string[] = []
  for (const p of proposals) {
    const target = targetOf(p.tool, p.args)
    const decision = target ? decided.get(target) : undefined
    if (!decision) kept.push(p)
    else
      notes.push(
        `Cas would propose ${p.tool} (${p.reason}), but ${decision.summary ?? decision.action} was a decision made on ${decision.createdAt.slice(0, 10)}${decision.reason ? ` (${decision.reason})` : ""}, so it's left alone.`
      )
  }
  return { kept, notes }
}

function parseArgs(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json)
    return v && typeof v === "object" && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

const brief = (c: PlanChange) => ({ at: c.createdAt, actor: c.actor, action: c.action, summary: c.summary })

export type RunResult = {
  snapshot: CasSnapshot
  added: Proposal[]
  superseded: number[]
  matched: Awaited<ReturnType<typeof autoComplete>>
}

const sameCall = (a: { tool: string; args: unknown }, b: { tool: string; args: unknown }) =>
  a.tool === b.tool && JSON.stringify(a.args) === JSON.stringify(b.args)

/** One background run: figures, one judgement, one snapshot. */
export async function runCas(deps: WorkerDeps): Promise<RunResult> {
  const { store, today } = deps
  const matched = await autoComplete(deps)
  // what the snapshot is based on, read first: anything recorded while it works makes it stale
  const [change, sync, previous, health, uncategorised, openNotes, pending, rejected] = await Promise.all([
    store.latestChange(),
    store.latestSync(),
    store.latestSnapshot(),
    deps.source.health(),
    store.uncategorisedCount(),
    store.openNotes(),
    store.listProposals(["pending"]),
    store.listProposals(["rejected"], 20),
  ])
  const figures = await loadFigures(deps.plan, { ...deps.source, health: async () => health }, today)
  const warnings = snapshotWarnings(health, figures, uncategorised)
  const since = format(subDays(parseISO(today), DECISION_DAYS), "yyyy-MM-dd")
  const [recent, decisions] = await Promise.all([
    store.changesAfter(previous?.basedOnChangeId ?? null),
    store.changesSince(since).then((cs) => cs.filter((c) => PERSON_ACTORS.includes(c.actor))),
  ])

  let judgement: Judgement | null = null
  let usage = { model: null as string | null, inputTokens: null as number | null, outputTokens: null as number | null, latencyMs: null as number | null }
  let error: string | null = null
  if (figures && deps.judge) {
    try {
      const out = await deps.judge(
        {
          today,
          figures,
          warnings,
          decisions: decisions.map((c) => ({ ...brief(c), reason: c.reason })),
          recentChanges: recent.map(brief),
          openNotes: openNotes.map(({ id, kind, content }) => ({ id, kind, content })),
          pendingProposals: pending.map((p) => ({ proposalId: p.id, tool: p.tool, args: p.args, reason: p.reason })),
          rejectedProposals: rejected.map((p) => ({ tool: p.tool, args: p.args, reason: p.reason, decisionReason: p.decisionReason })),
          previous: previous && { status: previous.status, headline: previous.headline, goalGap: previous.goalGap },
        },
        deps.model
      )
      judgement = out.judgement
      usage = out
    } catch (err) {
      error = err instanceof Error ? err.message : "The model failed"
    }
  } else if (figures) {
    error = "No Anthropic key: the snapshot is the figures alone"
  }

  const proposed = (judgement?.proposals ?? []).flatMap((p) => {
    const args = parseArgs(p.args)
    return args && !deps.validate?.(p.tool, args) ? [{ tool: p.tool, args, reason: p.reason }] : []
  })
  const { kept, notes: disagreements } = respectDecisions(proposed, decisions)

  // a pending proposal made on older data goes stale unless the judgement keeps it
  const keep = new Set(judgement?.keepProposalIds ?? [])
  const stale = (p: Proposal) =>
    p.source === "cas" &&
    judgement !== null &&
    !keep.has(p.id) &&
    (p.basedOnChangeId !== (change?.id ?? null) || p.basedOnSyncAt !== (sync?.at ?? null))
  const superseded: number[] = []
  for (const p of pending.filter(stale)) {
    if (await store.settleProposal(p.id, { status: "superseded", reason: "The data it was based on changed" }))
      superseded.push(p.id)
  }
  const stillPending = pending.filter((p) => !superseded.includes(p.id))
  const fresh: NewProposal[] = kept
    .filter((p) => !stillPending.some((q) => sameCall(p, q)) && !rejected.some((q) => sameCall(p, q)))
    .map((p) => ({ ...p, source: "cas", basedOnChangeId: change?.id ?? null, basedOnSyncAt: sync?.at ?? null }))
  const added = await store.addProposals(fresh)

  const openIds = new Set(figures?.actions.map((a) => a.actionId) ?? [])
  const topActions: TopAction[] = judgement
    ? judgement.topActions.slice(0, 5).map((a) => ({ ...a, actionId: a.actionId !== null && openIds.has(a.actionId) ? a.actionId : null }))
    : (figures?.actions ?? [])
        .filter((a) => a.status === "overdue" || a.status === "due_soon")
        .slice(0, 5)
        .map((a) => ({ title: a.title, detail: null, actionId: a.actionId, dueDate: a.dueDate }))

  const known = new Set(openNotes.map((n) => n.content.trim().toLowerCase()))
  for (const n of [
    ...(judgement?.notes ?? []),
    ...disagreements.map((content) => ({ kind: "observation" as const, content })),
  ]) {
    if (known.has(n.content.trim().toLowerCase())) continue
    known.add(n.content.trim().toLowerCase())
    await store.saveNote(n)
  }

  const noteIds = new Set(openNotes.map((n) => n.id))
  for (const r of judgement?.resolveNotes ?? [])
    if (noteIds.has(r.noteId)) await store.resolveNote(r.noteId, r.resolution.slice(0, 500))

  const snapshot = await store.saveSnapshot({
    status: figures?.status ?? "watch",
    headline: judgement?.headline || plainHeadline(figures),
    goalGap: figures?.goal?.gap ?? null,
    lowPoint: figures?.lowPoint ?? null,
    topActions,
    warnings,
    proposals: [...stillPending, ...added].map((p) => ({ proposalId: p.id, tool: p.tool, args: p.args, reason: p.reason })),
    figures,
    basedOnSyncAt: sync?.at ?? null,
    basedOnSyncRunId: sync?.runId ?? null,
    basedOnChangeId: change?.id ?? null,
    model: usage.model,
    escalationReason: null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: usage.latencyMs,
    error,
  })
  return { snapshot, added, superseded, matched }
}
