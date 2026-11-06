import "server-only"

import { getApiKey } from "@/lib/anthropic"
import { proposalProblem } from "@/lib/cas/proposals"
import { FIGURE_SOURCE, proposalTools } from "@/lib/cas/tools"
import { loadDataHealth } from "@/lib/data-health"
import type { MatchTx } from "@/lib/action-matching"
import { getDb, must } from "@/lib/db"
import { withTicket } from "@/lib/db/household"
import { planDeps } from "@/lib/plan-repo"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

import { claudeJudge } from "./judge-claude"
import { loadModelConfig } from "./model-config"
import { casStore } from "./store-db"
import { runCas } from "./worker"

/** Cas's background run for the signed-in user's household (or the one it's acting as). */
export async function runCasNow(opts: { deep?: boolean } = {}) {
  const tools = proposalTools()
  return runCas({
    validate: (tool, args) => proposalProblem(tools, tool, args),
    plan: await planDeps("cas", { quiet: true }),
    store: await casStore(),
    source: { ...FIGURE_SOURCE, health: () => loadDataHealth() },
    judge: (await getApiKey()) ? claudeJudge : null,
    models: await loadModelConfig(),
    deep: opts.deep,
    today: todayLocal(),
    system: await planDeps("system", { quiet: true }),
    transactions: async (since) =>
      (
        await must<MatchTx[]>(
          (await getDb())
            .from("transactions")
            .select("id, accountId:account_id, date, amount, description")
            .gte("date", since)
            .order("id")
            .limit(5000)
        )
      ).map((t) => ({ ...t, amount: Number(t.amount) })),
  })
}

/** Cas's background run, as whoever created the event's ticket. */
export function runCasWithTicket(ticket: string, opts: { deep?: boolean } = {}) {
  return withTicket(ticket, () => runCasNow(opts))
}
