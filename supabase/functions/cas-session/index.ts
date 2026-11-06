// Mint a short session for one of Cas's background runs, in exchange for a ticket.
//
// The app holds no admin key. Whatever triggers a run (a person changing the plan or asking
// for a refresh, or akahu-sync after a sync) creates a ticket in cas_tickets, and its id goes
// in the Inngest event. The worker posts the ticket here; if it's still good, this mints a
// session for the person who created it (never anyone else) and returns its access token,
// which expires within the hour. The worker signs it out when it's done. No refresh token
// is returned. See supabase/migrations/20261108000000_cas_tickets.sql.
//
// Called without a user JWT (verify_jwt is off in config.toml): the ticket is the credential.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.118.0"

const url = Deno.env.get("SUPABASE_URL")!
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, options)
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!

const TICKET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405)
  const body = await req.json().catch(() => ({}))
  const ticket = typeof body?.ticket === "string" ? body.ticket : ""
  // the same answer for every bad ticket, so it can't be used to probe for good ones
  const refused = () => json({ error: "That ticket isn't valid" }, 403)
  if (!TICKET.test(ticket)) return refused()

  try {
    const { data: rows, error } = await admin.rpc("redeem_cas_ticket", { p_ticket: ticket })
    if (error) throw error
    const redeemed = (rows as { household_id: string; user_id: string }[] | null)?.[0]
    if (!redeemed) return refused()

    const { data: found, error: userError } = await admin.auth.admin.getUserById(redeemed.user_id)
    if (userError || !found.user?.email) return refused()
    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: found.user.email,
    })
    if (linkError) throw linkError
    const { data: signedIn, error: otpError } = await createClient(url, anonKey, options).auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    })
    if (otpError || !signedIn.session) throw otpError ?? new Error("No session")

    return json({
      accessToken: signedIn.session.access_token,
      expiresAt: signedIn.session.expires_at,
      userId: redeemed.user_id,
      householdId: redeemed.household_id,
    })
  } catch (err) {
    console.error(err)
    return json({ error: "Couldn't start a session" }, 500)
  }
})
