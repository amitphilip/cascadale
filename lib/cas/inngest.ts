import "server-only"

import { NonRetriableError } from "inngest"

import { TicketRefused } from "@/lib/db/household"
import { inngest } from "@/lib/events"

import { runCasWithTicket } from "./run"
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
    const { householdId, ticket, deep } = event.data as { householdId?: string; ticket?: string; deep?: boolean }
    if (!householdId || !ticket) return { skipped: "no householdId or ticket" }
    return step.run("snapshot", async () => {
      // debounced: the event is the burst's last, so a deep refresh followed by a sync runs normally
      const run = await runCasWithTicket(ticket, { deep: deep === true }).catch((err) => {
        // a spent or expired ticket won't come good on a retry; the next event brings a new one
        throw err instanceof TicketRefused ? new NonRetriableError(err.message) : err
      })
      const { snapshot, matched } = run
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
