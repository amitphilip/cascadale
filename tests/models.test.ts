import { describe, expect, test } from "vitest"

import { chooseSnapshotTier, fallbackFor, modelConfig, modelForTask } from "@/lib/cas/models"
import { runCas } from "@/lib/cas/worker"
import { buildDataHealth } from "@/lib/health"

import { TODAY, healthInput } from "./fixtures/october-2026"
import { harness } from "./harness"
import { memoryCasStore } from "./memory-cas-store"

const figures = (status: "on_track" | "watch" | "off_track", gap: number) => ({
  status,
  goal: { endDate: "2027-01-01", target: 0, forecast: gap, gap, tone: status },
})
const base = { checkInDue: false, gapThreshold: 250 }

describe("model tiering", () => {
  test("defaults, overridden by settings over the environment", () => {
    const def = modelConfig(new Map())
    expect(modelForTask(def, "snapshot")).toBe("claude-haiku-5-5")
    expect(modelForTask(def, "ask")).toBe("claude-sonnet-5-5")
    expect(modelForTask(def, "check_in")).toBe("claude-sonnet-5-5")
    expect(modelForTask(def, "plan")).toBe("claude-opus-5-5")
    const set = modelConfig(new Map([["casModel.escalate", "claude-opus-5-5"]]), {
      CAS_MODEL_ESCALATE: "claude-sonnet-5",
      CAS_MODEL_DEFAULT: "claude-sonnet-5-5",
      CAS_ESCALATE_GAP: "500",
    })
    expect(set).toMatchObject({ escalate: "claude-opus-5-5", default: "claude-sonnet-5-5", gapThreshold: 500 })
  })

  test("escalates on a status change, off track, a gap move, an unsure run or a due check-in", () => {
    const prev = { status: "on_track", goalGap: 100, uncertain: false }
    expect(chooseSnapshotTier({ ...base, previous: prev, figures: figures("on_track", 150) })).toEqual({ tier: "default", reason: null })
    expect(chooseSnapshotTier({ ...base, previous: prev, figures: figures("watch", 50) }).reason).toMatch(/status changed/)
    expect(chooseSnapshotTier({ ...base, previous: { ...prev, status: "off_track" }, figures: figures("off_track", -900) }).reason).toBe("off track")
    expect(chooseSnapshotTier({ ...base, previous: prev, figures: figures("on_track", 400) }).reason).toMatch(/gap moved 300/)
    expect(chooseSnapshotTier({ ...base, previous: { ...prev, uncertain: true }, figures: figures("on_track", 100) }).tier).toBe("escalate")
    expect(chooseSnapshotTier({ ...base, checkInDue: true, previous: prev, figures: figures("on_track", 100) }).reason).toBe("a check-in is due")
    expect(chooseSnapshotTier({ ...base, deep: true, previous: prev, figures: figures("on_track", 100) }).tier).toBe("deep")
  })

  test("only the larger models get the server-side fallback", () => {
    expect(fallbackFor("claude-haiku-5-5")).toEqual({})
    expect(fallbackFor("claude-sonnet-5-5")).toMatchObject({ fallbacks: "default" })
  })

  test("each snapshot records the tier and model it ran on", async () => {
    const h = harness()
    const cas = memoryCasStore(h.changes, { lastCheckInAt: "2026-10-27T00:00:00Z" })
    const used: string[] = []
    const deps = {
      plan: { ...h.deps, actor: "cas" as const, onChange: undefined },
      store: cas.store,
      source: { ...h.ctx.figures, health: async () => buildDataHealth(healthInput()) },
      judge: async (_: unknown, model: string) => {
        used.push(model)
        return {
          judgement: { headline: "x", topActions: [], proposals: [], keepProposalIds: [], notes: [], resolveNotes: [], uncertain: true },
          model,
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 7,
        }
      },
      models: modelConfig(new Map()),
      today: TODAY,
    }
    const first = await runCas(deps)
    // the first run has nothing to compare with; it said it wasn't sure, so the next escalates
    const second = await runCas(deps)
    expect(used).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"])
    expect(first.snapshot).toMatchObject({ tier: "default", escalationReason: null, uncertain: true })
    expect(second.snapshot).toMatchObject({ tier: "escalate", escalationReason: "the last run wasn't sure", model: "claude-sonnet-5-5" })
  })
})
