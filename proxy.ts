import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"

const SIGN_IN = "/sign-in"
// Pages for signed-out users only; signed-in users are sent home.
const SIGNED_OUT_ONLY = [SIGN_IN, "/forgot-password"]
// Where password reset emails land: it exchanges the link for a session.
const AUTH_CONFIRM = "/auth/confirm"
// The MCP endpoint and its OAuth metadata check access tokens themselves (app/api/mcp).
const TOKEN_AUTH = ["/api/mcp", "/.well-known/"]

/** Refresh the Supabase session cookies, and send anyone signed out to the sign-in page. */
export async function proxy(request: NextRequest) {
  if (TOKEN_AUTH.some((p) => request.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next()
  }
  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(list) {
          for (const { name, value } of list) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of list)
            response.cookies.set(name, value, options)
        },
      },
    }
  )
  const { data } = await supabase.auth.getClaims()
  const signedIn = Boolean(data?.claims.sub)
  const { pathname, search } = request.nextUrl

  if (
    !signedIn &&
    !SIGNED_OUT_ONLY.includes(pathname) &&
    pathname !== AUTH_CONFIRM
  ) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Sign in first" }, { status: 401 })
    }
    const url = new URL(SIGN_IN, request.url)
    if (pathname !== "/") url.searchParams.set("next", pathname + search)
    return redirect(url, response)
  }
  if (signedIn && SIGNED_OUT_ONLY.includes(pathname))
    return redirect(new URL("/", request.url), response)
  return response
}

/** A redirect that keeps any refreshed session cookies. */
function redirect(url: URL, from: NextResponse) {
  const res = NextResponse.redirect(url)
  for (const cookie of from.cookies.getAll()) res.cookies.set(cookie)
  return res
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
