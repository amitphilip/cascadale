import { format, subDays, parseISO } from "date-fns"

import type { DataHealth } from "@/lib/health"
import type { PlanFigures } from "@/lib/plan-figures"
import { PERSON_ACTORS } from "@/lib/plan-instructions"
import { loadFigures, type FigureSource, type PlanChange, type PlanDeps } from "@/lib/plan-service"

import type { Judge, JudgeInput, Judgement } from "./judge"
import type { CasSnapshot, CasStore, SnapshotWarning, TopAction } from "./store"

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

export type RunResult = { snapshot: CasSnapshot; proposals: RawProposal[]; keepProposalIds: number[] }

/** One background run: figures, one judgement, one snapshot. */
export async function runCas(deps: WorkerDeps, extra: { pendingProposals?: JudgeInput["pendingProposals"] } = {}) {
  const { store, today } = deps
  // what the snapshot is based on, read first: anything recorded while it works makes it stale
  const [change, sync, previous, health, uncategorised, openNotes] = await Promise.all([
    store.latestChange(),
    store.latestSync(),
    store.latestSnapshot(),
    deps.source.health(),
    store.uncategorisedCount(),
    store.openNotes(),
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
          pendingProposals: extra.pendingProposals ?? [],
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
    return args ? [{ tool: p.tool, args, reason: p.reason }] : []
  })
  const { kept, notes: disagreements } = respectDecisions(proposed, decisions)

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

  const snapshot = await store.saveSnapshot({
    status: figures?.status ?? "watch",
    headline: judgement?.headline || plainHeadline(figures),
    goalGap: figures?.goal?.gap ?? null,
    lowPoint: figures?.lowPoint ?? null,
    topActions,
    warnings,
    proposals: kept.map((p) => ({ proposalId: null, ...p })),
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
  return { snapshot, proposals: kept, keepProposalIds: judgement?.keepProposalIds ?? [] } satisfies RunResult
}
