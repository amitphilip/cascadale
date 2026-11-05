import "server-only"

import { createClient } from "@supabase/supabase-js"

import { actingAs, supabaseEnv, tokenClient } from "@/lib/db"

/**
 * Run background work as a household's owner, through row level security like any request
 * of theirs: a short session is minted with the admin API (SUPABASE_SECRET_KEY, server only)
 * and signed out when the work is done. Nothing here bypasses the policies.
 */
export async function asHousehold<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const { url, key } = supabaseEnv()
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!secret) throw new Error("Set SUPABASE_SECRET_KEY so Cas can run in the background")
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(url, secret, options)

  const { data: found, error: userError } = await admin.auth.admin.getUserById(ownerId)
  if (userError || !found.user?.email) throw new Error(`No user ${ownerId} to run Cas for`)
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: found.user.email,
  })
  if (linkError) throw linkError
  const { data: signedIn, error: otpError } = await createClient(url, key, options).auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  })
  if (otpError || !signedIn.session) throw otpError ?? new Error("Couldn't sign in for the background run")

  const token = signedIn.session.access_token
  try {
    return await actingAs.run({ db: tokenClient(token), userId: ownerId }, fn)
  } finally {
    await admin.auth.admin.signOut(token, "local").catch(() => undefined)
  }
}
