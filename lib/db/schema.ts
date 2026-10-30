// Row shapes of the Supabase tables (supabase/migrations), in the camelCase the app uses.
// Selects alias the snake_case columns into these names (see COLUMNS in lib/db/index.ts).
// Timestamps arrive as ISO strings.

import type { CheckInResult, CheckInStats } from "@/lib/checkin-types"
import type { Plan, PlanSnapshot } from "@/lib/plan"
import type { RecurringBasis } from "@/lib/recurring"

export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit_card",
  "investment",
  "loan",
  "cash",
  "other",
] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const ASSET_KINDS = ["property", "vehicle", "investment", "other"] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

/** How a rule matches: substring of the description, or normalized merchant key. */
export const RULE_KINDS = ["contains", "merchant"] as const
export type RuleKind = (typeof RULE_KINDS)[number]

/** Who created the rule: you, the LLM, or learned from your corrections. */
export const RULE_SOURCES = ["manual", "ai", "learned"] as const
export type RuleSource = (typeof RULE_SOURCES)[number]

/** How a transaction got its category. */
export const CATEGORY_SOURCES = ["manual", "rule", "ai"] as const
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

export const CATEGORY_KINDS = ["expense", "income", "transfer"] as const
export type CategoryKind = (typeof CATEGORY_KINDS)[number]

/** Something you own and value by hand, for net worth. */
export type Asset = {
  id: number
  name: string
  kind: AssetKind
  value: number
  valuedOn: string
  note: string | null
}

export type Account = {
  id: number
  name: string
  type: AccountType
  institution: string | null
  openingBalance: number
  archived: boolean
  /** The Akahu account (acc_…) this account syncs from, if linked. */
  akahuId: string | null
  /** Only Akahu transactions after this date are synced (set when linking an account with history). */
  akahuStart: string | null
  createdAt: string
}

export type Category = {
  id: number
  name: string
  kind: CategoryKind
  monthlyBudget: number | null
}

/** One uploaded statement file. The raw file lives in the "statements" storage bucket. */
export type Statement = {
  id: number
  accountId: number
  fileName: string
  storedName: string
  rowCount: number
  insertedCount: number
  periodStart: string | null
  periodEnd: string | null
  importedAt: string
}

export type Transaction = {
  id: number
  accountId: number
  statementId: number | null
  date: string
  description: string
  /** Signed: negative is money out, positive is money in. */
  amount: number
  categoryId: number | null
  /** The rule that assigned the category, if any. */
  ruleId: number | null
  categorySource: CategorySource | null
  /** 0–100; null when uncategorized. */
  categoryConfidence: number | null
  notes: string | null
  source: "import" | "manual" | "akahu"
  /** Dedupe key for imported rows (the Akahu id for synced ones); null for manual entries. */
  hash: string | null
  createdAt: string
}

/**
 * "contains": case-insensitive substring of the description.
 * "merchant": pattern is a normalized merchant key (see lib/rules.ts), also
 * matched fuzzily.
 */
export type Rule = {
  id: number
  pattern: string
  categoryId: number
  kind: RuleKind
  source: RuleSource
  /** 0–100 */
  confidence: number
  /** Your own note about the merchant, e.g. what it actually is. */
  note: string | null
  /** For AI rules: the model's one-line explanation. */
  reason: string | null
  createdAt: string
}

/**
 * Your choices for a detected recurring series (see lib/recurring.ts), keyed by
 * category, direction and the rule that categorized it.
 */
export type RecurringOverrideRow = {
  key: string
  /** "latest" | "average" | "growth" | "custom"; null follows the page default */
  basis: RecurringBasis | null
  /** yearly growth as a fraction, e.g. 0.03; null uses the detected trend */
  growthRate: number | null
  /** monthly amount for the custom basis */
  amount: number | null
  /** not really recurring: count it as variable spending instead */
  excluded: boolean
  updatedAt: string
}

/** How a category is projected forward for budgeting (see lib/recurring.ts). */
export type CategoryProjectionRow = {
  categoryId: number
  /** "latest" | "average" | "growth" | "custom"; null follows the page default */
  basis: RecurringBasis | null
  /** yearly growth as a fraction, applied to every item without its own rate */
  growthRate: number | null
  /** monthly amount for the custom basis */
  amount: number | null
  updatedAt: string
}

/**
 * One planning conversation with the model. The snapshot of your finances it was
 * started from is frozen here, so the conversation replays the same way later.
 */
export type PlanThread = {
  id: number
  snapshot: PlanSnapshot
  /** who rebuilt it (lib/plan-service.ts); null when made in the planner chat */
  madeBy: "website" | "mcp" | "cas" | null
  createdAt: string
}

/** A turn in a planning conversation; assistant turns may carry a revised plan. */
export type PlanMessage = {
  id: number
  threadId: number
  role: "user" | "assistant"
  /** what you wrote, or the model's reply */
  content: string
  /** data sent to the model ahead of your message: the snapshot, or a simulation of the plan */
  context: string | null
  plan: Plan | null
  createdAt: string
}

/** A one-off expense you know is coming, e.g. a car service or a wedding gift. */
export type UpcomingExpense = {
  id: number
  name: string
  /** positive: the amount you expect to pay */
  amount: number
  dueDate: string
  /** account it will be paid from; null when not decided */
  accountId: number | null
  note: string | null
  createdAt: string
}

/**
 * A check-in on the overview: analytics over what was logged since the last one, and the
 * model's read on what to do about it.
 */
export type CheckIn = {
  id: number
  periodStart: string
  periodEnd: string
  stats: CheckInStats
  result: CheckInResult
  createdAt: string
}

export const NOTE_KINDS = ["observation", "decision", "preference", "todo"] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

/** Something Cas remembers between conversations (cas_notes). */
export type CasNote = {
  id: number
  kind: NoteKind
  content: string
  dueDate: string | null
  /** a decision that changes the plan; it stays unapplied until a plan change carries it out */
  affectsPlan: boolean
  appliedAt: string | null
  createdAt: string
  resolvedAt: string | null
  resolution: string | null
}
