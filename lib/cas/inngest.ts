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
    const householdId = (event.data as { householdId?: string }).householdId
    if (!householdId) return { skipped: "no householdId" }
    return step.run("snapshot", async () => {
      const { snapshot } = await runCasFor(householdId)
      return { snapshotId: snapshot.id, status: snapshot.status, basedOnChangeId: snapshot.basedOnChangeId }
    })
  }
)

export const functions = [casSnapshot]
