// Row shapes of the Supabase tables (supabase/migrations), in the camelCase the app uses.
// Selects alias the snake_case columns into these names (see COLUMNS in lib/db/index.ts).
// Timestamps arrive as ISO strings.

import type { RecurringBasis } from "@/lib/recurring"

export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit_card",
  "credit_line",
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
  /** Annual interest rate in percent (debt or savings), null when unknown. */
  interestRate: number | null
  createdAt: string
}

/** How often an expense category's budget resets. */
export const BUDGET_PERIODS = ["week", "month"] as const
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number]

export type Category = {
  id: number
  name: string
  kind: CategoryKind
  /** the monthly budget; for a weekly one, the weekly amount's monthly equivalent */
  monthlyBudget: number | null
  /** set when the budget is weekly: its weekly amount */
  weeklyBudget: number | null
  /** set when the budget is a percentage of projected income; the amounts above are what it comes to */
  budgetPercent: number | null
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

/** How often a one-off's money goes in, or its parts are paid out. */
export const ONE_OFF_FREQUENCIES = ["week", "fortnight", "month"] as const
export type OneOffFrequency = (typeof ONE_OFF_FREQUENCIES)[number]

/** single: paid in one go on the finish date; spread: in parts until it. */
export const ONE_OFF_OUT_MODES = ["single", "spread"] as const
export type OneOffOutMode = (typeof ONE_OFF_OUT_MODES)[number]

/**
 * A known total paid out by a finish date, with the money gathered in a tracking account
 * first (see lib/one-offs.ts). Several can share an account.
 */
export type OneOff = {
  id: number
  name: string
  /** positive: the whole amount to pay */
  total: number
  accountId: number
  startDate: string
  finishDate: string
  outMode: OneOffOutMode
  /** for a spread one: how often a part is paid, the last on the finish date */
  outEvery: OneOffFrequency | null
  /** how often money goes in for it, counted from the start date */
  inEvery: OneOffFrequency
  /** already in the account for it when it was added */
  setAside: number
  note: string | null
  createdAt: string
}

export const PLAN_VERDICTS = ["realistic", "stretch", "unrealistic"] as const
export type PlanVerdict = (typeof PLAN_VERDICTS)[number]

export const PLAN_PURPOSES = ["bills", "budget", "one_off", "savings", "goal", "buffer", "debt"] as const
export type PlanPurpose = (typeof PLAN_PURPOSES)[number]

export const PLAN_EVERY = ["week", "fortnight", "month", "once"] as const
export type PlanEvery = (typeof PLAN_EVERY)[number]

/** The monthly figures a plan was made from. */
export type PlanFigures = {
  income: number
  /** recurring bills and day-to-day spending: each category's budget, else its projection */
  committed: number
  /** put aside each month for one-off payments */
  oneOffs: number
  /** income less committed less one-offs */
  leftOver: number
}

/**
 * A plan (plans). The newest is the current one. Cas made them whole (website, mcp); now
 * Claude keeps the current one item by item through the plan tools (claude), or you do in
 * the app (you), and those have no verdict.
 */
export type Plan = {
  id: number
  goals: string | null
  summary: string
  verdict: PlanVerdict | null
  verdictNote: string | null
  goalChecks: { goal: string; fits: boolean; note: string }[]
  figures: PlanFigures
  madeBy: "website" | "mcp" | "claude" | "you"
  createdAt: string
}

/** Who made a change: Claude through the MCP tools, or a person in the app. */
export const CHANGE_MAKERS = ["claude", "you"] as const
export type ChangeMaker = (typeof CHANGE_MAKERS)[number]

/** An allocation or action on a plan (plan_items). */
export type PlanItem = {
  id: number
  planId: number
  kind: "allocation" | "action"
  purpose: PlanPurpose | null
  title: string
  detail: string | null
  amount: number | null
  every: PlanEvery | null
  categoryId: number | null
  oneOffId: number | null
  /** where the money should sit */
  accountId: number | null
  /** where the money leaves from, usually the account a pay lands in */
  fromAccountId: number | null
  /** whose pay it comes from; null when it's shared or not from a pay */
  fromMemberId: string | null
  /** when it runs from and to; null for open-ended */
  startDate: string | null
  endDate: string | null
  /** for a savings goal, debt or one-off: the amount it's working towards */
  target: number | null
  notes: string | null
  /** merchant keys (or account transfers as "to:<accountId>") that pay it, for plan_vs_actual */
  matchKeys: string[]
  dueDate: string | null
  doneAt: string | null
  /** soft-deleted: kept for its history, no longer part of the plan */
  removedAt: string | null
  updatedAt: string | null
  position: number
}

/** Something Cas tells the household without being asked (cas_nudges). */
export type CasNudge = {
  id: number
  kind: "payday" | "weekly"
  title: string
  body: string
  dedupeKey: string
  dueDate: string | null
  createdAt: string
  pushedAt: string | null
  doneAt: string | null
}

export const NOTE_KINDS = ["observation", "decision", "preference", "todo"] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

/** Something Cas remembers between conversations (cas_notes). */
export type CasNote = {
  id: number
  kind: NoteKind
  content: string
  dueDate: string | null
  /** from the old plan: a decision that changed it; no longer read */
  affectsPlan: boolean
  appliedAt: string | null
  /** set on notes the app raises itself, e.g. "uncategorized:<merchant key>" from a sync */
  ref: string | null
  /** for a decision about who pays for something: what it's about ("school fees") */
  subject: string | null
  /** and who pays it */
  payerMemberId: string | null
  createdAt: string
  resolvedAt: string | null
  resolution: string | null
}
