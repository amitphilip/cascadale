import { z } from "zod"

import { planTools } from "@/lib/cas/plan-tools"
import { buildDataHealth } from "@/lib/health"
import type { PlanSnapshot } from "@/lib/plan"
import type { PlanDeps } from "@/lib/plan-service"

import { currentSnapshot, healthInput, previousPlan } from "./fixtures/october-2026"
import { memoryRepo } from "./memory-repo"

/**
 * The plan's MCP tools over the October 2026 fixture and an in-memory repo, wired as
 * lib/cas/tools.ts wires them (acting as "mcp"). Arguments go through each tool's input
 * schema, as the MCP server does.
 */
export function harness(opts: { seedPlan?: boolean; decisions?: string[]; snapshot?: () => PlanSnapshot } = {}) {
  const store = memoryRepo({
    plan: opts.seedPlan === false ? undefined : previousPlan(),
    decisions: opts.decisions,
  })
  const deps: PlanDeps = {
    repo: store.repo,
    loadSnapshot: async () => (opts.snapshot ?? currentSnapshot)(),
    actor: "mcp",
  }
  const tools = planTools({
    deps: async () => deps,
    health: async () => {
      const latest = await store.repo.latestPlan()
      return buildDataHealth({
        ...healthInput(),
        plan: latest
          ? { createdAt: latest.createdAt, dataEnd: latest.snapshot.dataEnd, accounts: latest.snapshot.accounts }
          : null,
      })
    },
  })
  // results are checked as JSON, the way an MCP client reads them
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call<T = Record<string, any>>(name: string, args: object = {}): Promise<T> {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return (await t.run(z.object(t.input).parse(args) as never)) as T
  }
  return { ...store, deps, tools, call }
}
