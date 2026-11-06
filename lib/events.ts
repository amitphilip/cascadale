import "server-only"

import { Inngest } from "inngest"

import type { Db } from "@/lib/db"
import { createTicket } from "@/lib/db/household"

// Events between Cascadale and Cas's background worker, sent through Inngest:
// - plan/changed: a write through the shared layer (lib/plan-service.ts) was recorded
// - feeds/synced: a bank feed sync finished (sent by the akahu-sync edge function)
// - cas/refresh: someone asked for a fresh snapshot (refresh_cas)
// Each names its household, the key Cas's runs are debounced on, and carries a ticket the
// worker exchanges for a session as whoever triggered it (lib/db/household.ts).

type Base = { householdId: string; ticket: string }

export type CasEvents = {
  "plan/changed": Base & { changeId: number; actor: string; action: string }
  "feeds/synced": Base & { syncRunId: string; latestTransactionAt: string | null; inserted: number }
  "cas/refresh": Base & { reason?: string; deep?: boolean }
}

export type CasEvent = { [K in keyof CasEvents]: { name: K; data: CasEvents[K] } }[keyof CasEvents]

export const inngest = new Inngest({ id: "cascadale" })

/** Whether events can go anywhere: an Inngest event key, or the local dev server. */
export const eventsConfigured = () => Boolean(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_DEV)

type Unticketed = { [K in keyof CasEvents]: { name: K; data: Omit<CasEvents[K], "ticket"> } }[keyof CasEvents]

/**
 * Send an event, with a ticket created as the signed-in person on `db`. Never throws: a lost
 * event only delays Cas's next run.
 */
export async function emit(db: Db, event: Unticketed) {
  if (!eventsConfigured()) return { sent: false as const, reason: "Inngest isn't configured" }
  try {
    const ticket = await createTicket(db, event.name)
    await inngest.send({ ...event, data: { ...event.data, ticket } } as CasEvent)
    return { sent: true as const }
  } catch (err) {
    console.error(`${event.name} not sent`, err)
    return { sent: false as const, reason: err instanceof Error ? err.message : "send failed" }
  }
}
