import { describe, expect, test } from "vitest"

import { reportDiscrepancy } from "@/lib/cas/discrepancy"
import type { Judgement } from "@/lib/cas/judge"
import { loadStatus } from "@/lib/cas/status"
import { runCas } from "@/lib/cas/worker"
import { buildDataHealth } from "@/lib/health"

import { TODAY, healthInput } from "./fixtures/october-2026"
import { harness } from "./harness"
import { memoryCasStore } from "./memory-cas-store"

describe("report_discrepancy", () => {
  test("saves a discrepancy note, emits plan/changed and makes the snapshot stale until Cas reconciles it", async () => {
    const h = harness()
    const cas = memoryCasStore(h.changes)
    const told: string[] = []
    h.deps.onChange = async (c) => void told.push(c.action)
    const deps = (resolve: boolean) => ({
      plan: { ...h.deps, actor: "cas" as const, onChange: undefined },
      store: cas.store,
      source: { ...h.ctx.figures, health: async () => buildDataHealth(healthInput()) },
      judge: async (input: { openNotes: { id: number; kind: string }[] }, model: string) => ({
        judgement: {
          headline: "x",
          topActions: [],
          proposals: [],
          keepProposalIds: [],
          notes: [],
          uncertain: false,
          resolveNotes: resolve
            ? input.openNotes.filter((n) => n.kind === "discrepancy").map((n) => ({ noteId: n.id, resolution: "The transfer is in; ticked off" }))
            : [],
        } satisfies Judgement,
        model,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      }),
      model: "claude-haiku-5-5",
      today: TODAY,
    })
    await runCas(deps(false))

    const out = await reportDiscrepancy(h.deps, cas.store, {
      what: "The 943 transfer to Joint went through on 26 Oct",
      snapshotSays: "Move 943 to Joint is overdue",
      evidence: "transaction 512",
    })
    expect(cas.notes[0]).toMatchObject({ kind: "discrepancy", content: expect.stringMatching(/943.*\n.*overdue.*\n.*512/) })
    expect(told).toEqual(["report_discrepancy"])
    expect(out.change.actor).toBe("mcp")
    const status = await loadStatus(cas.store)
    expect(status.is_stale).toBe(true)
    expect(status.newer.changes.map((c) => c.action)).toEqual(["report_discrepancy"])

    await runCas(deps(true))
    expect(cas.notes[0]).toMatchObject({ resolution: "The transfer is in; ticked off" })
    expect(cas.notes[0].resolvedAt).not.toBeNull()
    expect((await loadStatus(cas.store)).is_stale).toBe(false)
  })
})
