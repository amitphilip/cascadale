import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// Cas switched off: nothing in Cascadale may reach the Anthropic API, during a sync or an
// MCP call. Every client comes from lib/anthropic.ts's anthropicClient, which refuses; the
// Cas entry points stop before they touch the database or the API; and the MCP servers
// don't offer the Cas tools.

const constructed = vi.hoisted(() => ({ count: 0 }))
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {}
  class Anthropic {
    static APIError = APIError
    static AuthenticationError = class extends APIError {}
    static RateLimitError = class extends APIError {}
    static APIConnectionError = class extends APIError {}
    constructor() {
      constructed.count++
    }
  }
  return { default: Anthropic }
})

// any database read means a Cas path ran further than its flag check
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: vi.fn(async () => {
    throw new Error("touched the database")
  }),
}))

beforeEach(() => {
  constructed.count = 0
  vi.stubEnv("CAS_ENABLED", "")
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test")
})
afterEach(() => vi.unstubAllEnvs())

describe("with CAS_ENABLED off", () => {
  test("casEnabled is off by default, and on only for true", async () => {
    const { casEnabled } = await import("@/lib/flags")
    expect(casEnabled()).toBe(false)
    vi.stubEnv("CAS_ENABLED", "TRUE")
    expect(casEnabled()).toBe(true)
    vi.stubEnv("CAS_ENABLED", "1")
    expect(casEnabled()).toBe(false)
  })

  test("anthropicClient refuses before it reads a key or makes a client", async () => {
    const { anthropicClient } = await import("@/lib/anthropic")
    await expect(anthropicClient()).rejects.toThrow(/Cas is switched off/)
    expect(constructed.count).toBe(0)
  })

  test("make_plan, redo_short_term and ask_cas stop at the flag", async () => {
    const [{ makePlan }, { refreshShortTerm }, { askCas }] = await Promise.all([
      import("@/lib/cas/plan"),
      import("@/lib/cas/short-term"),
      import("@/lib/cas/agent"),
    ])
    await expect(makePlan("goals", "mcp")).rejects.toThrow(/Cas is switched off/)
    await expect(askCas("Can I afford it?")).rejects.toThrow(/Cas is switched off/)
    // what a sync's page view used to trigger: now nothing, and no database read either
    await expect(refreshShortTerm({ force: true })).resolves.toBeNull()
    expect(constructed.count).toBe(0)
  })

  test("the Cascadale MCP server doesn't offer the Cas tools, and offers the planning ones", async () => {
    const { createToolsServer } = await import("@/lib/mcp")
    const names = Object.keys((createToolsServer("https://example.test") as unknown as { _registeredTools: object })._registeredTools)
    for (const gone of ["ask_cas", "make_plan", "redo_short_term", "update_cas"]) expect(names).not.toContain(gone)
    for (const tool of [
      "get_system_guide",
      "update_system_guide",
      "detect_recurring_payments",
      "plan_vs_actual",
      "cycle_position",
      "credit_card_due",
      "upsert_plan_item",
      "remove_plan_item",
      "get_plan_history",
      "get_short_term",
      "set_short_term",
      "preview_short_term",
      "what_if",
      "commit_purchase",
      "list_pending_changes",
      "approve_change",
      "reject_change",
      "get_change_log",
      "get_notes",
      "save_note",
      "resolve_note",
    ]) {
      expect(names).toContain(tool)
    }
    // the old note names still work for a release
    expect(names).toContain("read_notes")
  })

  test("the Cas MCP server keeps its notes but not ask_cas", async () => {
    const { createCasServer } = await import("@/lib/mcp")
    const names = Object.keys((createCasServer("https://example.test") as unknown as { _registeredTools: object })._registeredTools)
    expect(names.sort()).toEqual(["get_notes", "resolve_note"])
  })

  test("with the flag on, the Cas tools come back", async () => {
    vi.stubEnv("CAS_ENABLED", "true")
    const { createCasServer, createToolsServer } = await import("@/lib/mcp")
    const tools = Object.keys((createToolsServer("https://example.test") as unknown as { _registeredTools: object })._registeredTools)
    const cas = Object.keys((createCasServer("https://example.test") as unknown as { _registeredTools: object })._registeredTools)
    expect(tools).toEqual(expect.arrayContaining(["make_plan", "redo_short_term", "update_cas"]))
    expect(cas).toContain("ask_cas")
  })
})

describe("the only way to the Anthropic API", () => {
  // so the flag in anthropicClient covers every call, a sync's included
  test("no module makes an Anthropic client but lib/anthropic.ts", () => {
    const root = join(__dirname, "..")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", "data", "tests", ".git"].includes(name)) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    for (const dir of ["app", "lib", "components", "supabase"]) walk(join(root, dir))
    const makers = files.filter((f) => /new Anthropic\(|api\.anthropic\.com/.test(readFileSync(f, "utf8")))
    expect(makers.map((f) => f.slice(root.length + 1))).toEqual(["lib/anthropic.ts"])
  })
})
