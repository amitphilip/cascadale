import "server-only"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

import { bearerToken, tokenClient } from "@/lib/db"
import { askCas } from "@/lib/cas/agent"
import { withMoney } from "@/lib/cas/tool"
import { TOOLS, type CasTool } from "@/lib/cas/tools"
import { loadDataHealth } from "@/lib/data-health"
import { getSettings } from "@/lib/queries"

// Two MCP servers for clients such as claude.ai, each added as its own connector:
// - Cascadale (/api/mcp): your data and the actions on it, as plain tools.
// - Cas (/api/mcp/cas): the advisor agent, which investigates with the read tools
//   and remembers through its notes, and recommends actions for the client to run on Cascadale.
// Each request is authenticated by an access token from Supabase's OAuth server, and getDb
// acts as that token's user, so every tool sees only that user's rows, just like the app.

/** Each server's path, which is also its OAuth protected resource. */
export const MCP_RESOURCES = {
  tools: "/api/mcp",
  cas: "/api/mcp/cas",
} as const

const ACTION_NAMES = TOOLS.filter((t) => t.access === "action").map((t) => t.name)

const TOOLS_INSTRUCTIONS = `Cascadale is the user's budgeting app: bank accounts synced from Akahu, transactions, categories and budgets, recurring bills, a savings plan and check-ins. These tools read that data and act on it directly, through the same services and database as the website.

- get_briefing is the best single overview; the other read tools answer specific questions.
- These tools change the user's real finances: ${ACTION_NAMES.join(", ")}. Confirm with the user before calling one, and tell them what changed from the tool's result.
- Check data_health (on get_briefing, get_overview, get_plan and run_check_in) before relying on numbers: name stale accounts, drift from the bank and a plan built on balances that have since moved, rather than answering as if the data were current.
- The plan is the one on the website's Plan page. To change it, use upsert_pot / remove_pot (pots and set-asides) and add_plan_adjustment / remove_plan_adjustment (one-off changes on a date). These record the change and mark the plan out of date; then call regenerate_plan to rebuild it, passing expectedPlanId from get_plan. When get_plan says out_of_date (unapplied changes or Cas decisions), offer to apply and rebuild. Pass a fresh operationId with every write; retrying with the same one is safe.
- For advice (how am I doing, what should I do, can I afford X), use the Cas connector's ask_cas if it's connected; it recommends actions that you run here.
- Every response carries the household's currency and locale; amounts are in that currency. Transaction amounts are signed: negative is money out.`

const CAS_INSTRUCTIONS = `Cas is the user's financial advisor and accountant for their budgeting app, Cascadale. It investigates their accounts, bank feed syncs, transactions, budgets, recurring bills and plan on its own, remembers earlier conversations through its notes, and answers with what's going on and what can or should be done.

- Call ask_cas for open questions: how am I doing, what needs attention, can I afford X, explain my spending, plan for a goal. Pass what you know from the conversation as context, and tell it about decisions the user makes.
- Cas doesn't change the user's data. The actions it recommends (e.g. upsert_pot, add_plan_adjustment, categorize_merchant) are tools on the Cascadale connector: offer them to the user and run them there once confirmed, then resolve the matching to-do here with resolve_note.
- When the user decides something that changes the plan, tell Cas; it records the decision and the plan shows as out of date until a plan change carries it out (pass the decision's id as decisionIds).
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

/** Cascadale: every read and action tool. */
function createToolsServer() {
  const server = new McpServer(
    { name: "cascadale", title: "Cascadale", version: "0.1.0" },
    { instructions: TOOLS_INSTRUCTIONS }
  )
  for (const t of TOOLS) if (t.access !== "memory") register(server, t)
  return server
}

/** Cas: the advisor agent, plus a view of its notes. */
function createCasServer() {
  const server = new McpServer(
    { name: "cas", title: "Cas", version: "0.1.0" },
    { instructions: CAS_INSTRUCTIONS }
  )

  server.registerTool(
    "ask_cas",
    {
      title: "Ask Cas",
      description:
        "Ask Cas, the user's financial advisor and accountant agent, anything about their finances. It looks through their accounts, bank feed syncs, transactions, budgets, recurring bills, plan and its notes from earlier conversations, then answers with what's going on and suggested actions. Data health is checked first and given to Cas, and returned with the answer (stale accounts, drift from the bank, plan basis). Takes up to a few minutes on a broad question.",
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

  const byName = new Map(TOOLS.map((t) => [t.name, t]))
  register(server, byName.get("read_notes")!, "get_notes")
  register(server, byName.get("resolve_note")!)
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

    const server = which === "cas" ? createCasServer() : createToolsServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(request)
  }
}
