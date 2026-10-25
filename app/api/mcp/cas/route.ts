import { mcpHandler } from "@/lib/mcp"

// The Cas MCP server: the advisor agent (see lib/mcp.ts). proxy.ts lets it through
// without session cookies; each request carries an access token instead.

// ask_cas runs an agent that can take a few minutes on a broad question.
export const maxDuration = 300

const handle = mcpHandler("cas")

export { handle as GET, handle as POST, handle as DELETE }
