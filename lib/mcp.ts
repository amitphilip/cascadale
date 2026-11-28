import "server-only"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

import { bearerToken, tokenClient } from "@/lib/db"
import { CAS_PRACTICE, CAS_ROLE } from "@/lib/persona"
import { getSettings } from "@/lib/queries"
import { withMoney } from "@/lib/tool"
import { TOOLS, type CascadaleTool } from "@/lib/tools"

// Cascadale's MCP server for clients such as claude.ai, added as a connector: your data, the
// household's notes and the actions on them, with instructions that make the client Cas.
// Each request is authenticated by an access token from Supabase's OAuth server, and getDb
// acts as that token's user, so every tool sees only that user's rows, just like the app.

/** The server's path, which is also its OAuth protected resource. */
export const MCP_RESOURCE = "/api/mcp"

// On the Cascadale connector Claude itself is Cas: it gets Cas's role and practice, every
// read, memory and action tool, and asks before changing anything. Answers are as quick as
// the tools (which matters for voice). Claude also does the planning, through the plan tools.
function instructions() {
  const actions = TOOLS.filter((t) => t.access === "action").map((t) => t.name)
  return `Cascadale is the user's household budgeting app: bank accounts synced hourly from Akahu, transactions, categories and budgets, recurring payments, one-off payments, a shared plan, each member's short-term allocation for their pay, net worth, and notes. These tools read that data and act on it directly, through the same services and database as the website. Cascadale keeps the data, the rules and the figures; you make the judgement calls, including the planning.

When the user talks about their money, be Cas for them.

${CAS_ROLE}

${CAS_PRACTICE}

Using these tools:
- get_briefing is the best single overview; get_inbox is what Home shows them to do; get_system_guide explains this household's setup for planning; the other read tools answer specific questions.
- These tools change the user's real finances: ${actions.join(", ")}. Confirm with the user before calling one, and tell them what changed from the tool's result. Notes (save_note, resolve_note) are the household's memory and need no confirmation.
- In voice or chat, answer in a few plain sentences: the verdict or number first, then what to do. Offer detail rather than reading out lists.
- Every response carries the household's currency and locale; amounts are in that currency. Transaction amounts are signed: negative is money out.`
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

/** Every response carries the household's currency and locale, so amounts are never read as the wrong one. */
async function withHouseholdMoney(value: unknown) {
  return withMoney(value, await getSettings())
}

function failure(err: unknown) {
  const message = err instanceof Error ? err.message : "Something went wrong"
  return { ...json({ error: message }), isError: true }
}

function register(server: McpServer, t: CascadaleTool) {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.input,
      annotations: {
        readOnlyHint: t.access === "read",
        destructiveHint: t.access === "action",
        idempotentHint: "operationId" in t.input,
        openWorldHint: false,
      },
    },
    async (args: object) => {
      try {
        return json(await withHouseholdMoney(await t.run(args as never)))
      } catch (err) {
        return failure(err)
      }
    }
  )
}

/** Who's serving: the site's address and the app icon, so Claude shows the mark beside the connector. */
function serverMeta(origin: string) {
  return {
    websiteUrl: origin,
    icons: [
      { src: `${origin}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      { src: `${origin}/icons/192`, mimeType: "image/png", sizes: ["192x192"] },
      { src: `${origin}/icons/512`, mimeType: "image/png", sizes: ["512x512"] },
    ],
  }
}

/** Cascadale: every read, memory and action tool, with Claude as Cas. */
export function createServer(origin: string) {
  const server = new McpServer(
    { name: "cascadale", title: "Cascadale", version: "0.4.0", ...serverMeta(origin) },
    { instructions: instructions() }
  )
  for (const t of TOOLS) register(server, t)
  return server
}

/** Whether the token is a valid, unexpired access token for one of our users. */
async function isValid(token: string | null) {
  if (!token) return false
  try {
    const { data } = await tokenClient(token).auth.getClaims(token)
    return Boolean(data?.claims.sub)
  } catch {
    // getClaims throws on tokens that aren't JWTs at all.
    return false
  }
}

/** The route handler serving the server (Streamable HTTP, stateless). */
export function mcpHandler() {
  return async (request: Request) => {
    if (!(await isValid(bearerToken(request.headers.get("authorization"))))) {
      // Tells the client where to find the authorization server, so it can sign the user in.
      const metadata = new URL(
        `/.well-known/oauth-protected-resource${MCP_RESOURCE}`,
        request.url
      )
      return Response.json(
        { error: "invalid_token", error_description: "Sign in to Cascadale first" },
        {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` },
        }
      )
    }

    const origin = new URL(request.url).origin
    const server = createServer(origin)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(request)
  }
}
