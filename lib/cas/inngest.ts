import "server-only"

import { inngest } from "@/lib/events"

import { runCasFor } from "./run"
import { CAS_TRIGGERS, DEBOUNCE } from "./schedule"

/** Cas's background run, on every sync, plan change and refresh, debounced per household. */
export const casSnapshot = inngest.createFunction(
  {
    id: "cas-snapshot",
    name: "Cas snapshot",
    triggers: CAS_TRIGGERS.map((event) => ({ event })),
    debounce: DEBOUNCE,
    concurrency: { key: "event.data.householdId", limit: 1 },
    retries: 2,
  },
  async ({ event, step }) => {
    const { householdId, deep } = event.data as { householdId?: string; deep?: boolean }
    if (!householdId) return { skipped: "no householdId" }
    return step.run("snapshot", async () => {
      // debounced: the event is the burst's last, so a deep refresh followed by a sync runs normally
      const { snapshot, matched } = await runCasFor(householdId, { deep: deep === true })
      return {
        snapshotId: snapshot.id,
        status: snapshot.status,
        basedOnChangeId: snapshot.basedOnChangeId,
        model: snapshot.model,
        tier: snapshot.tier,
        escalationReason: snapshot.escalationReason,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        latencyMs: snapshot.latencyMs,
        ticked: matched.ticked,
      }
    })
  }
)

export const functions = [casSnapshot]
