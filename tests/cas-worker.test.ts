import { describe, expect, test } from "vitest"

import { modelConfig } from "@/lib/cas/models"

import type { Judge, Judgement } from "@/lib/cas/judge"
import { CAS_TRIGGERS, DEBOUNCE } from "@/lib/cas/schedule"
import { respectDecisions, runCas, type WorkerDeps } from "@/lib/cas/worker"
import { buildDataHealth } from "@/lib/health"

import { TODAY, healthInput } from "./fixtures/october-2026"
import { harness } from "./harness"
import { memoryCasStore } from "./memory-cas-store"

function worker(h: ReturnType<typeof harness>, judge: Judge | null = null) {
  const cas = memoryCasStore(h.changes, { uncategorised: 3, lastCheckInAt: "2026-10-27T00:00:00Z" })
  const deps: WorkerDeps = {
    plan: { ...h.deps, actor: "cas", onChange: undefined },
    store: cas.store,
    source: { ...h.ctx.figures, health: async () => buildDataHealth(healthInput()) },
    judge,
    models: modelConfig(new Map()),
    today: TODAY,
  }
  return { ...cas, deps, run: () => runCas(deps) }
}

const judgement = (over: Partial<Judgement> = {}): Judgement => ({
  headline: "On track",
  topActions: [],
  proposals: [],
  keepProposalIds: [],
  notes: [],
  resolveNotes: [],
  uncertain: false,
  ...over,
})

const fakeJudge =
  (j: Judgement): Judge =>
  async (_input, model) => ({ judgement: j, model, inputTokens: 1200, outputTokens: 300, latencyMs: 900 })

describe("Cas's background run", () => {
  test("is debounced per household on syncs, plan changes and refreshes", () => {
    expect(CAS_TRIGGERS).toEqual(["feeds/synced", "plan/changed", "cas/refresh"])
    expect(DEBOUNCE.key).toBe("event.data.householdId")
    const seconds = Number(DEBOUNCE.period.replace("s", ""))
    expect(seconds).toBeGreaterThanOrEqual(60)
    expect(seconds).toBeLessThanOrEqual(120)
  })

  test("without a model, the snapshot is the figures, based on the latest change", async () => {
    const h = harness()
    await h.call("upsert_pot", { operationId: "op-1", name: "Tax", amount: 200, frequency: "monthly", fromAccountId: 2 })
    const w = worker(h)
    w.syncs.push({ at: "2026-10-28T08:07:00Z", runId: "run-1" })
    const { snapshot } = await w.run()
    expect(snapshot.basedOnChangeId).toBe(h.changes.at(-1)!.id)
    expect(snapshot).toMatchObject({ basedOnSyncAt: "2026-10-28T08:07:00Z", basedOnSyncRunId: "run-1", model: null })
    expect(snapshot.headline).toMatch(/goal|track/)
    expect(snapshot.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(["drift", "uncategorised"]))
  })

  test("Cas and the MCP tools give identical figures", async () => {
    const h = harness()
    const { figures } = await h.call("get_plan")
    const { snapshot } = await worker(h).run()
    const fromCas = snapshot.figures as typeof figures
    // get_plan works them out against the real today; compare on the same day
    expect(fromCas.goal).toEqual(figures.goal)
    expect(fromCas.lowPoint).toEqual(figures.lowPoint)
    expect(fromCas.drift).toEqual(figures.drift)
    expect(snapshot.goalGap).toBe(figures.goal.gap)
    expect(snapshot.lowPoint).toEqual(figures.lowPoint)
  })

  test("records the model, tokens and latency of its judgement", async () => {
    const h = harness()
    const { snapshot } = await worker(h, fakeJudge(judgement({ headline: "Fine, $1,200 ahead" }))).run()
    expect(snapshot).toMatchObject({
      headline: "Fine, $1,200 ahead",
      model: "claude-haiku-5-5",
      tier: "default",
      inputTokens: 1200,
      outputTokens: 300,
      latencyMs: 900,
      error: null,
    })
  })

  test("a model failure still writes a snapshot from the figures", async () => {
    const h = harness()
    const { snapshot } = await worker(h, async () => {
      throw new Error("overloaded")
    }).run()
    expect(snapshot.error).toBe("overloaded")
    expect(snapshot.headline).toMatch(/goal|track/)
  })

  test("never proposes undoing a person's decision; it raises a note instead", async () => {
    const h = harness()
    await h.call("upsert_pot", { operationId: "op-1", name: "Tax", amount: 200, frequency: "monthly", fromAccountId: 2, reason: "IRD" })
    const w = worker(
      h,
      fakeJudge(
        judgement({
          proposals: [
            { tool: "remove_pot", args: JSON.stringify({ name: "tax" }), reason: "It overdraws Joint" },
            { tool: "add_plan_action", args: JSON.stringify({ title: "Check the power bill" }), reason: "It doubled" },
          ],
        })
      )
    )
    const { snapshot } = await w.run()
    expect(snapshot.proposals.map((p) => p.tool)).toEqual(["add_plan_action"])
    expect(w.notes).toHaveLength(1)
    expect(w.notes[0].content).toMatch(/remove_pot.*decision/)
  })

  test("Cas's own changes aren't decisions it has to respect", () => {
    const { kept } = respectDecisions(
      [{ tool: "remove_pot", args: { name: "Tax" }, reason: "x" }],
      [] // only person actors are passed in as decisions
    )
    expect(kept).toHaveLength(1)
  })
})

describe("get_status", () => {
  test("is stale until Cas runs after a new change or sync, and says what's newer", async () => {
    const { loadStatus } = await import("@/lib/cas/status")
    const h = harness()
    const w = worker(h)
    expect((await loadStatus(w.store)).is_stale).toBe(true)

    await w.run()
    expect((await loadStatus(w.store)).is_stale).toBe(false)

    w.syncs.push({ at: "2099-01-01T00:00:00Z", runId: "run-2" })
    const afterSync = await loadStatus(w.store)
    expect(afterSync.is_stale).toBe(true)
    expect(afterSync.newer.syncs).toEqual([{ at: "2099-01-01T00:00:00Z", syncRunId: "run-2" }])

    await w.run()
    await h.call("add_plan_action", { title: "Ring the bank" })
    const afterChange = await loadStatus(w.store)
    expect(afterChange.is_stale).toBe(true)
    expect(afterChange.newer.changes.map((c) => c.action)).toEqual(["add_plan_action"])
  })

  test("answers from stored rows alone, well under a second", async () => {
    const { loadStatus } = await import("@/lib/cas/status")
    const w = worker(harness())
    await w.run()
    const started = performance.now()
    await loadStatus(w.store)
    expect(performance.now() - started).toBeLessThan(50)
  })
})
