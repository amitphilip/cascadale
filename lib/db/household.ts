import "server-only"

import { actingAs, supabaseEnv, tokenClient, type Db } from "@/lib/db"

/**
 * Background work (Cas's runs) acts as a person without a request of theirs, and without
 * the app holding any admin key: the event that started it carries a ticket, created by
 * that person (or by the sync), which the cas-session edge function exchanges for a short
 * session as them. Every query then goes through row level security like any request.
 * See supabase/migrations/20261108000000_cas_tickets.sql.
 */

/** Create a ticket for a background run, as the signed-in person. Returns its id. */
export async function createTicket(db: Db, reason: string) {
  const id = crypto.randomUUID()
  // no select back: nobody can read tickets, not even their creator
  const { error } = await db.from("cas_tickets").insert({ id, reason: reason.slice(0, 200) })
  if (error) throw new Error(`Couldn't create a ticket for Cas: ${error.message}`)
  return id
}

/** Run `fn` as whoever created the ticket, signing the session out afterwards. */
export async function withTicket<T>(ticket: string, fn: () => Promise<T>): Promise<T> {
  const { url, key } = supabaseEnv()
  const res = await fetch(`${url}/functions/v1/cas-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ ticket }),
  })
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; userId?: string; error?: string }
  if (!res.ok || !body.accessToken || !body.userId)
    throw new TicketRefused(body.error ?? `cas-session answered ${res.status}`)

  try {
    return await actingAs.run({ db: tokenClient(body.accessToken), userId: body.userId }, fn)
  } finally {
    // end the session now rather than letting it run out
    await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${body.accessToken}` },
    }).catch(() => undefined)
  }
}

/** The ticket was spent, expired or never valid: retrying won't help. */
export class TicketRefused extends Error {}
