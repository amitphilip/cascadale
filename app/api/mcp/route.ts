import { mcpHandler } from "@/lib/mcp"

// Cascadale MCP server: your data and actions as tools (see lib/mcp.ts). proxy.ts lets it
// through without session cookies; each request carries an access token instead.

const handle = mcpHandler("tools")

export { handle as GET, handle as POST, handle as DELETE }
