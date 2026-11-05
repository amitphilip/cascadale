import "server-only"

import { Inngest } from "inngest"

// Events between Cascadale and Cas's background worker, sent through Inngest:
// - plan/changed: a write through the shared layer (lib/plan-service.ts) was recorded
// - feeds/synced: a bank feed sync finished (sent by the akahu-sync edge function)
// - cas/refresh: someone asked for a fresh snapshot (refresh_cas)
// Each names its household, the key Cas's runs are debounced on.

export type CasEvents = {
  "plan/changed": { householdId: string; changeId: number; actor: string; action: string }
  "feeds/synced": {
    householdId: string
    syncRunId: string
    latestTransactionAt: string | null
    inserted: number
  }
  "cas/refresh": { householdId: string; reason?: string; deep?: boolean }
}

export type CasEvent = { [K in keyof CasEvents]: { name: K; data: CasEvents[K] } }[keyof CasEvents]

export const inngest = new Inngest({ id: "cascadale" })

/** Whether events can go anywhere: an Inngest event key, or the local dev server. */
export const eventsConfigured = () => Boolean(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV)

/** Send an event. Never throws: a lost event only delays Cas's next run. */
export async function emit(event: CasEvent) {
  if (!eventsConfigured()) return { sent: false as const, reason: "Inngest isn't configured" }
  try {
    await inngest.send(event)
    return { sent: true as const }
  } catch (err) {
    console.error(`${event.name} not sent`, err)
    return { sent: false as const, reason: err instanceof Error ? err.message : "send failed" }
  }
}
