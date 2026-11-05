import type { PlanFigures } from "@/lib/plan-figures"

/**
 * Which model Cas uses for what. Three tiers, each configurable in the settings table
 * (key casModel.<tier>) or the environment (CAS_MODEL_<TIER>), falling back to:
 * - default: snapshot runs and routing (Claude Haiku 5.5)
 * - escalate: check-ins, trade-off questions (ask_cas, the Plan chat), and snapshot runs
 *   the rule below escalates (Claude Sonnet 5.5)
 * - deep: deep reviews and making a new plan (Claude Opus 5.5)
 * Categorisation has its own setting (casModel.categorise), since its web search tool
 * differs by model; it stays on the deep model unless set.
 */

export const TIERS = ["default", "escalate", "deep"] as const
export type Tier = (typeof TIERS)[number]

export const DEFAULT_MODELS: Record<Tier, string> = {
  default: "claude-haiku-5-5",
  escalate: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
}

export const MODEL_TASKS = ["snapshot", "ask", "chat", "check_in", "plan", "categorise"] as const
export type ModelTask = (typeof MODEL_TASKS)[number]

/** Each task's tier when nothing escalates it. */
export const TASK_TIERS: Record<ModelTask, Tier> = {
  snapshot: "default",
  ask: "escalate",
  chat: "escalate",
  check_in: "escalate",
  plan: "deep",
  categorise: "deep",
}

export const modelSettingKey = (key: Tier | "categorise") => `casModel.${key}`
export const GAP_THRESHOLD_SETTING = "casModel.escalateGap"
/** The goal's gap moving by more than this between runs escalates the next one. */
export const DEFAULT_GAP_THRESHOLD = 250
/** A check-in is due when the last one is this old (or there's none). */
export const CHECK_IN_DAYS = 7

export type ModelConfig = Record<Tier, string> & { categorise: string | null; gapThreshold: number }

/** The config from settings rows and the environment. */
export function modelConfig(settings: Map<string, string>, env: Record<string, string | undefined> = {}): ModelConfig {
  const pick = (key: Tier | "categorise") =>
    settings.get(modelSettingKey(key))?.trim() || env[`CAS_MODEL_${key.toUpperCase()}`]?.trim() || null
  const gap = Number(settings.get(GAP_THRESHOLD_SETTING) ?? env.CAS_ESCALATE_GAP)
  return {
    default: pick("default") ?? DEFAULT_MODELS.default,
    escalate: pick("escalate") ?? DEFAULT_MODELS.escalate,
    deep: pick("deep") ?? DEFAULT_MODELS.deep,
    categorise: pick("categorise"),
    gapThreshold: Number.isFinite(gap) && gap > 0 ? gap : DEFAULT_GAP_THRESHOLD,
  }
}

export function modelForTask(config: ModelConfig, task: ModelTask) {
  if (task === "categorise") return config.categorise ?? config.deep
  return config[TASK_TIERS[task]]
}

/**
 * Whether a snapshot run escalates from the default model, and why: a deep review was asked
 * for, the status changed or is off track, the goal's gap moved past the threshold, the last
 * run was unsure, or a check-in is due.
 */
export function chooseSnapshotTier(input: {
  previous: { status: string; goalGap: number | null; uncertain: boolean } | null
  figures: Pick<PlanFigures, "status" | "goal"> | null
  checkInDue: boolean
  gapThreshold: number
  deep?: boolean
}): { tier: Tier; reason: string | null } {
  const { previous, figures } = input
  if (input.deep) return { tier: "deep", reason: "a deep review was asked for" }
  if (!figures) return { tier: "default", reason: null }
  if (previous && previous.status !== figures.status)
    return { tier: "escalate", reason: `status changed from ${previous.status} to ${figures.status}` }
  if (figures.status === "off_track") return { tier: "escalate", reason: "off track" }
  const gap = figures.goal?.gap ?? null
  if (previous?.goalGap != null && gap !== null && Math.abs(gap - previous.goalGap) > input.gapThreshold)
    return { tier: "escalate", reason: `the goal's gap moved ${Math.round(gap - previous.goalGap)}` }
  if (previous?.uncertain) return { tier: "escalate", reason: "the last run wasn't sure" }
  if (input.checkInDue) return { tier: "escalate", reason: "a check-in is due" }
  return { tier: "default", reason: null }
}

/** Claude Haiku has no server-side refusal fallback; the larger models fall back by default. */
export const fallbackFor = (model: string) =>
  model.startsWith("claude-haiku")
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
