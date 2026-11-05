import { z } from "zod"

import type { CasTool } from "@/lib/cas/tool"
import { recordChange, type PlanDeps } from "@/lib/plan-service"

import { PROPOSABLE_TOOLS } from "./judge"
import type { CasStore, Proposal } from "./store"

/**
 * Cas's proposals: tool calls it suggests, run through the shared layer once a person
 * approves them, as actor "user" with the proposal linked on the change. MCP's
 * approve_proposal and the Plan page's Approve button both come here.
 */

export type ProposalContext = {
  store: CasStore
  /** the plan service acting as "user" */
  deps: PlanDeps
  /** the action tools a proposal may run, acting as "user" */
  tools: CasTool[]
}

const proposable = new Set<string>(PROPOSABLE_TOOLS)

function toolFor(tools: CasTool[], name: string) {
  if (!proposable.has(name)) return null
  return tools.find((t) => t.name === name && t.access === "action") ?? null
}

/** Why a proposed call can't run, or null when its arguments fit the tool. */
export function proposalProblem(tools: CasTool[], tool: string, args: Record<string, unknown>) {
  const t = toolFor(tools, tool)
  if (!t) return `${tool} can't be proposed`
  const parsed = z.object(t.input).safeParse({ operationId: "check", ...args })
  return parsed.success ? null : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
}

const operationIdFor = (p: Proposal) => `proposal-${p.id}`

type Outcome = { proposalId: number; status: Proposal["status"]; changeId?: number | null; result?: unknown; error?: string }

async function approveOne(ctx: ProposalContext, id: number): Promise<Outcome> {
  const p = await ctx.store.getProposal(id)
  if (!p) return { proposalId: id, status: "failed", error: `No proposal ${id}` }
  if (p.status !== "pending") return { proposalId: id, status: p.status, changeId: p.changeId, error: `Already ${p.status}` }
  const t = toolFor(ctx.tools, p.tool)
  const reason = `Approved Cas's proposal: ${p.reason}`.slice(0, 500)
  try {
    if (!t) throw new Error(`${p.tool} can't be run from a proposal`)
    const args = z.object(t.input).parse({ ...p.args, operationId: operationIdFor(p), reason })
    // plan tools record their own change; the proposal rides along on its meta
    const logged = "operationId" in t.input
    const result = (
      logged
        ? await t.run({ ...args, proposalId: p.id } as never)
        : await recordChange(ctx.deps, p.tool, { operationId: operationIdFor(p), reason, proposalId: p.id }, async () => ({
            summary: `${t.title}, as Cas proposed`,
            result: { output: await t.run(args as never) },
          }))
    ) as { change?: { id: number } }
    const settled = await ctx.store.settleProposal(p.id, {
      status: "approved",
      changeId: result.change?.id ?? null,
      result,
    })
    return { proposalId: id, status: settled?.status ?? "approved", changeId: result.change?.id ?? null, result }
  } catch (err) {
    const error = err instanceof Error ? err.message : "It didn't run"
    await ctx.store.settleProposal(p.id, { status: "failed", error })
    return { proposalId: id, status: "failed", error }
  }
}

/** Approve proposals, one after another (each may change what the next one sees). */
export async function approveProposals(ctx: ProposalContext, ids: number[]) {
  const out: Outcome[] = []
  for (const id of [...new Set(ids)]) out.push(await approveOne(ctx, id))
  return { results: out }
}

/** Reject proposals. The rejection is a decision on the change log, so Cas doesn't propose it again. */
export async function rejectProposals(ctx: ProposalContext, ids: number[], reason?: string | null) {
  const out: Outcome[] = []
  for (const id of [...new Set(ids)]) {
    const p = await ctx.store.settleProposal(id, { status: "rejected", reason: reason?.trim() || null })
    if (!p) {
      const existing = await ctx.store.getProposal(id)
      out.push({ proposalId: id, status: existing?.status ?? "failed", error: existing ? `Already ${existing.status}` : `No proposal ${id}` })
      continue
    }
    const change = await recordChange(
      ctx.deps,
      "reject_proposal",
      { operationId: `reject-${id}`, reason: reason?.trim() || null, proposalId: id },
      async () => ({
        summary: `Rejected Cas's proposal: ${p.tool}`,
        result: { changed: { proposal: { before: { ...p, status: "pending" }, after: p } } },
      })
    )
    out.push({ proposalId: id, status: "rejected", changeId: change.change.id })
  }
  return { results: out }
}

/** A proposal in a line, for the Plan page and list_proposals. */
export function describeProposal(p: Pick<Proposal, "tool" | "args">) {
  const a = p.args
  const str = (k: string) => (typeof a[k] === "string" || typeof a[k] === "number" ? String(a[k]) : null)
  switch (p.tool) {
    case "upsert_pot":
      return `Set aside ${str("amount")} ${str("frequency")} into ${str("name")}`
    case "remove_pot":
      return `Remove the ${str("name")} pot`
    case "add_plan_adjustment":
      return `${str("kind") === "skip" ? "Skip" : str("kind") === "add" ? "Add" : "Change"} ${str("name") ?? str("target")}${str("amount") ? ` (${str("amount")})` : ""} on ${str("date")}`
    case "remove_plan_adjustment":
      return `Cancel adjustment ${str("adjustmentId")}`
    case "add_plan_action":
      return `Add action: ${str("title")}`
    case "set_plan_action_done":
      return `${a.done === false ? "Reopen" : "Tick off"} action ${str("actionId")}`
    case "add_upcoming_expense":
      return `Expect ${str("name")}, ${str("amount")} on ${str("dueDate")}`
    case "categorize_merchant":
      return `Categorise ${str("merchantKey")}`
    case "set_transaction_category":
      return `Recategorise transaction ${str("transactionId")}`
    case "set_category_budgets":
      return "Change category budgets"
    default:
      return p.tool
  }
}
