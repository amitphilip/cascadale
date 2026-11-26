// Feature flags, read from the environment so they can change without a code change.
// Plain functions (not constants) so tests can flip them with vi.stubEnv.

/**
 * Cas, the in-app agent that called the Anthropic API to make the plan, redo the short-term
 * allocation, answer ask_cas and categorize merchants with AI. Off by default: Claude, through
 * the Cascadale MCP server, does the planning, and Cascadale keeps the data, the rules and the
 * deterministic figures. Set CAS_ENABLED=true to bring it back. The code stays until two clean
 * pay cycles have run with it off.
 */
export function casEnabled() {
  return process.env.CAS_ENABLED?.trim().toLowerCase() === "true"
}

export const CAS_DISABLED_MESSAGE =
  "Cas is switched off (CAS_ENABLED is not set): Claude does the planning through Cascadale's tools now."
