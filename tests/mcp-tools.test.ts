import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

// Cas, the old in-app agent, is gone: Claude does the planning through Cascadale's MCP tools,
// and nothing in Cascadale calls an AI API itself.

async function toolNames() {
  const { createServer } = await import("@/lib/mcp")
  return Object.keys((createServer("https://example.test") as unknown as { _registeredTools: object })._registeredTools)
}

describe("the Cascadale MCP server", () => {
  test("offers the planning and notes tools", async () => {
    const names = await toolNames()
    for (const tool of [
      "get_briefing",
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
  })

  test("doesn't offer the old Cas agent's tools or their old names", async () => {
    const names = await toolNames()
    for (const gone of [
      "ask_cas",
      "make_plan",
      "redo_short_term",
      "update_cas",
      "read_notes",
      "get_cas_notes",
      "save_cas_note",
      "resolve_cas_note",
    ]) {
      expect(names).not.toContain(gone)
    }
  })
})

describe("no AI API in Cascadale", () => {
  test("no module uses the Anthropic SDK or API", () => {
    const root = join(__dirname, "..")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", "data", ".git"].includes(name)) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    for (const dir of ["app", "lib", "components", "supabase"]) walk(join(root, dir))
    const users = files.filter((f) => /@anthropic-ai\/sdk|api\.anthropic\.com/.test(readFileSync(f, "utf8")))
    expect(users.map((f) => f.slice(root.length + 1))).toEqual([])
  })
})
