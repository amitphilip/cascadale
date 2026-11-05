import { describe, expect, test } from "vitest"

import { modelConfig } from "@/lib/cas/models"

import type { Judge, Judgement } from "@/lib/cas/judge"
import { approveProposals, proposalProblem, rejectProposals, type ProposalContext } from "@/lib/cas/proposals"
import { planTools } from "@/lib/cas/plan-tools"
import { runCas } from "@/lib/cas/worker"
import { buildDataHealth } from "@/lib/health"

import { TODAY, healthInput } from "./fixtures/october-2026"
import { harness } from "./harness"
import { memoryCasStore } from "./memory-cas-store"

function setup() {
  const h = harness()
  const cas = memoryCasStore(h.changes)
  const userDeps = { ...h.deps, actor: "user" as const }
  const tools = planTools({ ...h.ctx, deps: async () => userDeps })
  const ctx: ProposalContext = { store: cas.store, deps: userDeps, tools }
  const judged = (j: Partial<Judgement>): Judge => async (_i, model) => ({
    judgement: { headline: "x", topActions: [], proposals: [], keepProposalIds: [], notes: [], resolveNotes: [], uncertain: false, ...j },
    model,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  })
  const run = (judge: Judge) =>
    runCas({
      plan: { ...h.deps, actor: "cas", onChange: undefined },
      store: cas.store,
      source: { ...h.ctx.figures, health: async () => buildDataHealth(healthInput()) },
      judge,
      models: modelConfig(new Map()),
      today: TODAY,
      validate: (tool, args) => proposalProblem(tools, tool, args),
    })
  return { h, cas, ctx, judged, run }
}

const potCall = { tool: "upsert_pot" as const, args: JSON.stringify({ name: "Tax", amount: 300, frequency: "monthly", fromAccountId: 2 }), reason: "GST due in Jan" }

describe("Cas's proposals", () => {
  test("a run stores what Cas proposes, dropping calls whose arguments don't fit the tool", async () => {
    const s = setup()
    const { snapshot } = await s.run(
      s.judged({ proposals: [potCall, { tool: "upsert_pot", args: JSON.stringify({ name: "Bad" }), reason: "x" }] })
    )
    expect(s.cas.proposals.map((p) => p.tool)).toEqual(["upsert_pot"])
    expect(snapshot.proposals).toEqual([expect.objectContaining({ proposalId: s.cas.proposals[0].id, tool: "upsert_pot" })])
  })

  test("approving runs it through the shared layer as the user, linked to the proposal, once", async () => {
    const s = setup()
    await s.run(s.judged({ proposals: [potCall] }))
    const [p] = s.cas.proposals
    const first = await approveProposals(s.ctx, [p.id])
    expect(first.results[0]).toMatchObject({ status: "approved" })
    expect(s.h.pots.map((x) => x.name)).toEqual(["Tax"])
    const change = s.h.changes.at(-1)!
    expect(change).toMatchObject({ actor: "user", action: "upsert_pot", proposalId: p.id })
    expect(s.cas.proposals[0]).toMatchObject({ status: "approved", changeId: change.id })

    const again = await approveProposals(s.ctx, [p.id])
    expect(again.results[0]).toMatchObject({ status: "approved", error: "Already approved" })
    expect(s.h.changes.filter((c) => c.action === "upsert_pot")).toHaveLength(1)
  })

  test("a rejection is recorded as the user's decision and isn't proposed again", async () => {
    const s = setup()
    await s.run(s.judged({ proposals: [potCall] }))
    const [p] = s.cas.proposals
    await rejectProposals(s.ctx, [p.id], "We pay GST from savings")
    expect(s.h.changes.at(-1)).toMatchObject({ actor: "user", action: "reject_proposal", proposalId: p.id })
    await s.run(s.judged({ proposals: [potCall] }))
    expect(s.cas.proposals).toHaveLength(1)
  })

  test("pending proposals go stale when the data changes, unless Cas keeps them", async () => {
    const s = setup()
    await s.run(s.judged({ proposals: [potCall] }))
    const [p] = s.cas.proposals
    // nothing changed: it stays pending even if the judgement doesn't mention it
    await s.run(s.judged({}))
    expect(s.cas.proposals[0].status).toBe("pending")
    // a change made since: kept when Cas says so, superseded otherwise
    await s.h.call("add_plan_action", { title: "Ring IRD" })
    await s.run(s.judged({ keepProposalIds: [p.id] }))
    expect(s.cas.proposals[0].status).toBe("pending")
    await s.h.call("add_plan_action", { title: "Ring the bank" })
    const { superseded, snapshot } = await s.run(s.judged({}))
    expect(superseded).toEqual([p.id])
    expect(s.cas.proposals[0].status).toBe("superseded")
    expect(snapshot.proposals).toEqual([])
  })

  test("a failing call marks the proposal failed with why", async () => {
    const s = setup()
    const [p] = await s.cas.store.addProposals([
      { tool: "remove_pot", args: { name: "Nope" }, reason: "x", source: "cas", basedOnChangeId: null, basedOnSyncAt: null },
    ])
    const out = await approveProposals(s.ctx, [p.id])
    expect(out.results[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/No pot named/) })
  })
})
