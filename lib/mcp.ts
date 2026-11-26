import "server-only"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

import { bearerToken, tokenClient } from "@/lib/db"
import { askCas } from "@/lib/cas/agent"
import { CAS_ROLE, practice } from "@/lib/cas/knowledge"
import { withMoney } from "@/lib/cas/tool"
import { TOOLS, type CasTool } from "@/lib/cas/tools"
import { loadDataHealth } from "@/lib/data-health"
import { casEnabled } from "@/lib/flags"
import { getSettings } from "@/lib/queries"

// MCP servers for clients such as claude.ai, each added as its own connector:
// - Cascadale (/api/mcp): your data, Cas's notes and the actions on them, with instructions
//   that make the client Cas. This is the one to connect.
// - Cas (/api/mcp/cas): the older advisor agent (ask_cas runs a second model over the read
//   tools). Kept so existing connectors keep working.
// Each request is authenticated by an access token from Supabase's OAuth server, and getDb
// acts as that token's user, so every tool sees only that user's rows, just like the app.

/** Each server's path, which is also its OAuth protected resource. */
export const MCP_RESOURCES = {
  tools: "/api/mcp",
  cas: "/api/mcp/cas",
} as const

/** The tools offered now: the Cas agent's own (make_plan, redo_short_term, update_cas) only while Cas is on. */
export function offeredTools(casOn = casEnabled()) {
  return TOOLS.filter((t) => casOn || !t.requiresCas)
}

/**
 * Old tool names kept working for one release after the rename to notes, each pointing at
 * the tool it now is. Remove after the release that follows Cas's decommissioning.
 */
export const TOOL_ALIASES: Record<string, string> = {
  read_notes: "get_notes",
  get_cas_notes: "get_notes",
  save_cas_note: "save_note",
  resolve_cas_note: "resolve_note",
}

/** A tool's name on the Cascadale server: read_notes is get_notes there, as people already know it. */
const publicName = (t: CasTool) => (t.name === "read_notes" ? "get_notes" : t.name)

// On the Cascadale connector Claude itself is Cas: it gets Cas's role and practice, every
// read, memory and action tool, and asks before changing anything. Nothing runs a second
// agent, so answers are as quick as the tools (which matters for voice). With Cas switched
// off (the default), Claude also does the planning, through the plan tools.
function toolsInstructions(casOn: boolean) {
  const actions = offeredTools(casOn)
    .filter((t) => t.access === "action")
    .map(publicName)
  return `Cascadale is the user's household budgeting app: bank accounts synced hourly from Akahu, transactions, categories and budgets, recurring payments, one-off payments, a shared plan, each member's short-term allocation for their pay, net worth, and notes. These tools read that data and act on it directly, through the same services and database as the website. Cascadale keeps the data, the rules and the figures${casOn ? "" : "; you make the judgement calls, including the planning"}.

When the user talks about their money, be Cas for them.

${CAS_ROLE}

${practice(casOn)}

Using these tools:
- get_briefing is the best single overview; get_inbox is what Home shows them to do; ${casOn ? "" : "get_system_guide explains this household's setup for planning; "}the other read tools answer specific questions.
- These tools change the user's real finances: ${actions.join(", ")}. Confirm with the user before calling one, and tell them what changed from the tool's result. Notes (save_note, resolve_note) are the household's memory and need no confirmation.
- In voice or chat, answer in a few plain sentences: the verdict or number first, then what to do. Offer detail rather than reading out lists.
- Every response carries the household's currency and locale; amounts are in that currency. Transaction amounts are signed: negative is money out.`
}

const CAS_INSTRUCTIONS_OFF = `This is the older Cas connector. Cas, the advisor agent, is switched off: Claude does the planning through the Cascadale connector's tools now. Use the Cascadale connector; this one only shows the household's notes (get_notes, resolve_note).`

const CAS_INSTRUCTIONS = `This is the older Cas connector; the Cascadale connector now carries everything Cas does (its notes too), and answers faster. Prefer Cascadale's tools when both are connected.

Cas is the user's financial advisor and accountant for their budgeting app, Cascadale. It investigates their accounts, bank feed syncs, transactions, budgets, recurring bills, one-off payments and plan on its own, remembers earlier conversations through its notes, and answers with what's going on and what can or should be done.

- Call ask_cas for open questions: how am I doing, what needs attention, can I afford X, explain my spending, is my plan realistic, am I on track for a one-off payment. Say whether the user means their own accounts or the whole household. Pass what you know from the conversation as context, and tell it about decisions the user makes.
- Cas doesn't change the user's data. The actions it recommends (e.g. categorize_merchant, set_category_budgets) are tools on the Cascadale connector: offer them to the user and run them there once confirmed, then resolve the matching to-do here with resolve_note.
- ask_cas returns data_health alongside the answer; mention stale or drifted data to the user.
- get_notes shows its open to-dos, decisions and observations without running the agent.`

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

function register(server: McpServer, t: CasTool, name = t.name) {
  server.registerTool(
    name,
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
export function createToolsServer(origin: string) {
  const casOn = casEnabled()
  const server = new McpServer(
    { name: "cascadale", title: "Cascadale", version: "0.3.0", ...serverMeta(origin) },
    { instructions: toolsInstructions(casOn) }
  )
  const tools = offeredTools(casOn)
  for (const t of tools) register(server, t, publicName(t))
  const byName = new Map(tools.map((t) => [publicName(t), t]))
  for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
    const t = byName.get(target)
    if (!t || byName.has(alias)) continue
    register(server, { ...t, description: `Old name for ${target}, kept for one release: use ${target}. ${t.description}` }, alias)
  }
  return server
}

/** Cas: the advisor agent, plus a view of its notes. */
export function createCasServer(origin: string) {
  const casOn = casEnabled()
  const server = new McpServer(
    { name: "cas", title: "Cas", version: "0.2.0", ...serverMeta(origin) },
    { instructions: casOn ? CAS_INSTRUCTIONS : CAS_INSTRUCTIONS_OFF }
  )

  const byName = new Map(TOOLS.map((t) => [t.name, t]))
  register(server, byName.get("read_notes")!, "get_notes")
  register(server, byName.get("resolve_note")!)
  // ask_cas runs the agent on the Anthropic API: only while Cas is on
  if (!casOn) return server

  server.registerTool(
    "ask_cas",
    {
      title: "Ask Cas",
      description:
        "Ask Cas, the user's financial advisor and accountant agent, anything about their finances. It looks through their accounts, bank feed syncs, transactions, budgets, recurring bills and its notes from earlier conversations, then answers with what's going on and suggested actions. Data health is checked first and given to Cas, and returned with the answer (stale accounts, drift from the bank). Takes up to a few minutes on a broad question.",
      inputSchema: {
        question: z.string().trim().min(1),
        context: z
          .string()
          .optional()
          .describe("Anything relevant the user has told you, e.g. goals, decisions or constraints"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ question, context }) => {
      try {
        const health = await loadDataHealth()
        const { answer, toolsUsed } = await askCas(question, context, health)
        return {
          content: [
            { type: "text" as const, text: answer },
            { type: "text" as const, text: `(Cas checked: ${toolsUsed.join(", ") || "nothing"})` },
            { type: "text" as const, text: JSON.stringify(await withHouseholdMoney({ data_health: health })) },
          ],
        }
      } catch (err) {
        return failure(err)
      }
    }
  )

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

/** A route handler serving one of the servers (Streamable HTTP, stateless). */
export function mcpHandler(which: keyof typeof MCP_RESOURCES) {
  return async (request: Request) => {
    if (!(await isValid(bearerToken(request.headers.get("authorization"))))) {
      // Tells the client where to find the authorization server, so it can sign the user in.
      const metadata = new URL(
        `/.well-known/oauth-protected-resource${MCP_RESOURCES[which]}`,
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
    const server = which === "cas" ? createCasServer(origin) : createToolsServer(origin)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(request)
  }
}
