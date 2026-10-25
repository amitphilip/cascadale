import { NextResponse, type NextRequest } from "next/server"
import type { EmailOtpType } from "@supabase/supabase-js"

import { getDb } from "@/lib/db"

/**
 * Where password reset emails link to. Swaps the link's one-time code for a session, then
 * continues to `next`. Handles both Supabase's default link (`?code=`, which only works in
 * the browser that asked for it) and a `{{ .TokenHash }}` email template (any browser).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const code = params.get("code")
  const tokenHash = params.get("token_hash")
  const type = params.get("type") as EmailOtpType | null
  const next = params.get("next")
  // Only continue to paths on this site.
  const to = next?.startsWith("/") && !next.startsWith("//") ? next : "/"

  const db = await getDb()
  const { error } = code
    ? await db.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await db.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("missing code") }

  if (error) {
    const url = new URL("/sign-in", request.url)
    url.searchParams.set("error", "link")
    return NextResponse.redirect(url)
  }
  return NextResponse.redirect(new URL(to, request.url))
}
