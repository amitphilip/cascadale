import "server-only"

import { getApiKey } from "@/lib/anthropic"
import { FIGURE_SOURCE } from "@/lib/cas/tools"
import { loadDataHealth } from "@/lib/data-health"
import { asHousehold } from "@/lib/db/household"
import { planDeps } from "@/lib/plan-repo"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

import { claudeJudge } from "./judge-claude"
import { casStore } from "./store-db"
import { runCas } from "./worker"

/** The model for snapshot runs (lib/cas/models.ts makes this configurable). */
const SNAPSHOT_MODEL = "claude-haiku-5-5"

/** Cas's background run for the signed-in user's household (or the one it's acting as). */
export async function runCasNow() {
  return runCas({
    plan: await planDeps("cas", { quiet: true }),
    store: await casStore(),
    source: { ...FIGURE_SOURCE, health: () => loadDataHealth() },
    judge: (await getApiKey()) ? claudeJudge : null,
    model: SNAPSHOT_MODEL,
    today: todayLocal(),
  })
}

/** Cas's background run for a household, signed in as its owner. */
export function runCasFor(householdId: string) {
  return asHousehold(householdId, runCasNow)
}
