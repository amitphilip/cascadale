import { supabaseEnv } from "@/lib/db"
import { MCP_RESOURCE } from "@/lib/mcp"

/**
 * OAuth protected resource metadata (RFC 9728) for the MCP server, at
 * /.well-known/oauth-protected-resource/<server path>: it points clients at Supabase Auth,
 * which signs users in through /oauth/consent and issues their access tokens.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/.well-known/oauth-protected-resource/[[...resource]]">
) {
  const { resource = [] } = await ctx.params
  const path = resource.length ? `/${resource.join("/")}` : MCP_RESOURCE
  if (path !== MCP_RESOURCE) return Response.json({ error: "Unknown resource" }, { status: 404 })
  return Response.json(
    {
      resource: new URL(path, request.url).href,
      authorization_servers: [`${supabaseEnv().url}/auth/v1`],
      bearer_methods_supported: ["header"],
      resource_name: "Cascadale",
    },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  )
}
