import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"

import { anthropicClient } from "@/lib/anthropic"
import { COLUMNS, DbError, getDb, must, selectAll, type Db } from "@/lib/db"
import type { AccountType, Category, Rule } from "@/lib/db/schema"
import { buildMatcher, merchantKey } from "@/lib/rules"

const MODEL = "claude-opus-5-5"
/**
 * Merchants per LLM request. Input size isn't the constraint (1M context);
 * output is: each answer with its reason is ~40 tokens, plus thinking and
 * search at high effort, so 500 stays well under the 128K output cap. Most
 * users have fewer merchants than this, so it's normally a single request.
 */
const BATCH_SIZE = 500
const MAX_TOKENS = 128000
const UNKNOWN = "UNKNOWN"

/** Rows the user hasn't claimed: auto-categorized or never categorized (a PostgREST or filter). */
const NOT_MANUAL = "category_source.is.null,category_source.neq.manual"

/** Every rule, for buildMatcher. */
export function getAllRules(db: Db) {
  return selectAll<Rule>((from, to) =>
    db.from("rules").select(COLUMNS.rules).order("id").range(from, to)
  )
}

/**
 * Categorize uncategorized transactions with the rule table only (no LLM).
 * Rows you explicitly left uncategorized are skipped.
 */
export async function applyRulesToUncategorized(db?: Db) {
  db ??= await getDb()
  const match = buildMatcher(await getAllRules(db))
  const rows = await selectAll<{ id: number; description: string }>((from, to) =>
    db
      .from("transactions")
      .select("id, description")
      .is("category_id", null)
      .or(NOT_MANUAL)
      .order("id")
      .range(from, to)
  )

  // Group identical outcomes so we issue one UPDATE per (rule, confidence).
  const groups = new Map<string, { ids: number[]; m: NonNullable<ReturnType<typeof match>> }>()
  for (const r of rows) {
    const m = match(r.description)
    if (!m) continue
    const k = `${m.ruleId}|${m.confidence}`
    const g = groups.get(k) ?? { ids: [], m }
    g.ids.push(r.id)
    groups.set(k, g)
  }
  let n = 0
  for (const { ids, m } of groups.values()) {
    n += await setCategories(db, ids, {
      categoryId: m.categoryId,
      ruleId: m.ruleId,
      source: m.source,
      confidence: m.confidence,
    })
  }
  return n
}

/** Categorize the given transactions that are still uncategorized; returns how many changed. */
export function setCategories(
  db: Db,
  ids: number[],
  c: { categoryId: number; ruleId: number; source: "rule" | "ai"; confidence: number }
) {
  return must<number>(
    db.rpc("set_transaction_categories", {
      p_ids: ids,
      p_category_id: c.categoryId,
      p_rule_id: c.ruleId,
      p_source: c.source,
      p_confidence: c.confidence,
    })
  )
}

/** Create or update the merchant rule for a key; returns its id. */
export async function upsertMerchantRule(
  db: Db,
  key: string,
  values: {
    categoryId: number
    source: "ai" | "learned"
    confidence: number
    reason?: string | null
  }
) {
  const row = {
    category_id: values.categoryId,
    source: values.source,
    confidence: values.confidence,
    ...(values.reason !== undefined && { reason: values.reason }),
  }
  const [existing] = await must<{ id: number }[]>(
    db.from("rules").select("id").eq("kind", "merchant").eq("pattern", key).limit(1)
  )
  if (existing) {
    await must(db.from("rules").update(row).eq("id", existing.id))
    return existing.id
  }
  const created = await must<{ id: number }>(
    db
      .from("rules")
      .insert({ ...row, pattern: key, kind: "merchant" })
      .select("id")
      .single()
  )
  return created.id
}

/**
 * Move every auto-categorized transaction of a rule to its current category.
 * Transactions you set by hand are left alone.
 */
export async function syncRuleTransactions(db: Db, ruleId: number) {
  const [rule] = await must<Pick<Rule, "categoryId" | "source" | "confidence">[]>(
    db
      .from("rules")
      .select("categoryId:category_id, source, confidence")
      .eq("id", ruleId)
  )
  if (!rule) return 0
  const { count, error } = await db
    .from("transactions")
    .update(
      {
        category_id: rule.categoryId,
        category_source: rule.source === "ai" ? "ai" : "rule",
        category_confidence: rule.confidence,
      },
      { count: "exact" }
    )
    .eq("rule_id", ruleId)
    .or(NOT_MANUAL)
  if (error) throw new DbError(error)
  return count ?? 0
}

// ── LLM ─────────────────────────────────────────────────────────────────────

type Merchant = {
  key: string
  samples: string[]
  amounts: number[]
  dates: string[]
  accounts: Set<string>
  notes: string[]
}

/** Everything we know about a merchant, condensed for the prompt. */
function describeMerchant(m: Merchant, id: number) {
  const sorted = [...m.amounts].sort((a, b) => a - b)
  const round = (n: number) => Math.round(n * 100) / 100
  const months = new Set(m.dates.map((d) => d.slice(0, 7)))
  const dates = [...m.dates].sort()
  return {
    id,
    descriptions: m.samples,
    transactions: m.amounts.length,
    money_out: m.amounts.filter((a) => a < 0).length,
    money_in: m.amounts.filter((a) => a > 0).length,
    total: round(m.amounts.reduce((a, b) => a + b, 0)),
    typical_amount: round(sorted[Math.floor(sorted.length / 2)]),
    smallest: round(sorted[0]),
    largest: round(sorted[sorted.length - 1]),
    first_date: dates[0],
    last_date: dates[dates.length - 1],
    distinct_months: months.size,
    accounts: [...m.accounts],
    ...(m.notes.length > 0 && { user_notes: m.notes }),
  }
}

type Context = {
  categories: Pick<Category, "id" | "name" | "kind">[]
  /** Merchants the user has already categorized or corrected. */
  examples: { merchant: string; category: string; note: string | null }[]
  currency: string
  country: string | null
}

function systemPrompt(ctx: Context) {
  const list = ctx.categories.map((c) => `- ${c.name} (${c.kind})`).join("\n")
  const examples = ctx.examples.length
    ? ctx.examples
        .map((e) => `- ${e.merchant} → ${e.category}${e.note ? ` (note: ${e.note})` : ""}`)
        .join("\n")
    : "(none yet)"
  return `You categorize one person's bank and credit card transactions into their own fixed set of categories.

Categories:
${list}

How this person has categorized other merchants (follow their conventions):
${examples}

Amounts are in ${ctx.currency}${ctx.country ? `; the person lives in ${ctx.country}, so local merchants and banks are likely from there` : ""}. Negative is money out, positive is money in.

Each merchant comes with its raw bank descriptions and statistics: how many transactions, how many were in vs out, typical/smallest/largest amount, the date range and in how many distinct months it appears, which accounts it hit, and any notes the person wrote. Use all of it:
- Direction: money in from an employer is Salary; interest earned is income, interest charged is a fee or loan cost.
- Regularity: a similar amount in most months suggests a subscription, rent, utility, insurance or loan repayment.
- Amount size: separates a coffee shop from a furniture store with a similar name, or groceries from a one-off.
- Account: payments into a credit card or loan account, or moves between the person's own accounts, are transfers.
- Names of people (e.g. "FROM J SMITH") are usually transfers or gifts; use the direction and amounts to decide.

Use web search when a merchant name is unfamiliar or ambiguous and knowing what the business is would change the answer. Don't search for well-known merchants or for descriptions that are clearly generic (e.g. "TRANSFER", "INTEREST").

When you're done, call submit_categories once with an entry for every merchant id. For each: the single best category name exactly as listed, a confidence from 0 to 100 (90+ when the business and its category are clear; below 60 when you're guessing), and a short reason a person can check at a glance (e.g. "Pharmacy chain, NZ" or "Same amount every month, likely rent"). If nothing points to a category, use "${UNKNOWN}" with confidence 0.`
}

const SUBMIT = "submit_categories"

async function classifyBatch(client: Anthropic, ctx: Context, batch: Merchant[]) {
  const names = [...ctx.categories.map((c) => c.name), UNKNOWN]
  const Result = z.object({
    results: z.array(
      z.object({
        id: z.number(),
        category: z.string(),
        confidence: z.number(),
        reason: z.string(),
      })
    ),
  })
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: Math.min(50, Math.max(5, Math.ceil(batch.length / 4))),
      ...(ctx.country && { user_location: { type: "approximate" as const, country: ctx.country } }),
    },
    {
      name: SUBMIT,
      description:
        "Submit the category decision for every merchant in the batch. Call exactly once, at the end.",
      strict: true,
      eager_input_streaming: true,
      input_schema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", description: "The merchant's id from the input" },
                category: { type: "string", enum: names },
                confidence: { type: "integer", description: "0 to 100" },
                reason: { type: "string", description: "One short line" },
              },
              required: ["id", "category", "confidence", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["results"],
        additionalProperties: false,
      },
    },
  ]

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: JSON.stringify(batch.map(describeMerchant)) },
  ]
  // Web search runs a server-side loop that can pause; a turn may also end
  // without the submit call. Resume a few times, appending only.
  for (let turn = 0; turn < 6; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: systemPrompt(ctx), cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    })
    const response = await stream.finalMessage()
    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to categorize this batch")
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The model's answer was cut off; try again with fewer merchants")
    }

    const call = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === SUBMIT
    )
    if (call) {
      // Streamed tool input isn't validated by the API, so check it here.
      const parsed = Result.safeParse(call.input)
      if (!parsed.success) throw new Error("The model returned malformed results")
      return toAnswers(ctx, batch, parsed.data.results)
    }

    messages.push({ role: "assistant", content: response.content })
    if (response.stop_reason !== "pause_turn") {
      messages.push({ role: "user", content: `Now call ${SUBMIT} with every merchant.` })
    }
  }
  throw new Error("The model didn't return results")
}

function toAnswers(
  ctx: Context,
  batch: Merchant[],
  results: { id: number; category: string; confidence: number; reason: string }[]
) {
  const byName = new Map(ctx.categories.map((c) => [c.name.toLowerCase(), c.id]))
  return results.flatMap((r) => {
    const merchant = batch[r.id]
    const categoryId = byName.get(r.category.trim().toLowerCase())
    if (!merchant || !categoryId) return []
    const confidence = Math.round(Math.max(0, Math.min(100, r.confidence)))
    return [{ key: merchant.key, categoryId, confidence, reason: r.reason.trim() || null }]
  })
}

/** Region from a locale like "en-NZ", for localizing web search. */
function countryFromLocale(locale: string) {
  try {
    return new Intl.Locale(locale).maximize().region ?? null
  } catch {
    return null
  }
}

export type AutoCategorizeResult = {
  /** Categorized by existing rules, without calling the LLM. */
  byRules: number
  /** Merchants sent to the LLM. */
  merchantsAsked: number
  /** Transactions categorized from the LLM's answers. */
  byAi: number
  /** Still uncategorized afterwards. */
  remaining: number
}

/**
 * 1. Apply rules (exact merchant, contains, fuzzy) — free.
 * 2. Send only the merchants still unmatched to the LLM, one entry per
 *    merchant rather than per transaction.
 * 3. Save each answer as a merchant rule, so the same merchant is matched
 *    locally next time, then apply rules again.
 */
export async function autoCategorize(): Promise<AutoCategorizeResult> {
  const db = await getDb()
  const byRules = await applyRulesToUncategorized(db)

  const rows = await selectAll<{
    description: string
    amount: number
    date: string
    notes: string | null
    account: string
    accountType: AccountType
  }>((from, to) =>
    db
      .from("transactions")
      .select(
        "description, amount, date, notes, ...accounts!inner(account:name, accountType:type)"
      )
      .is("category_id", null)
      .or(NOT_MANUAL)
      .order("id")
      .range(from, to)
  )

  const merchants = new Map<string, Merchant>()
  for (const r of rows) {
    const key = merchantKey(r.description)
    const m = merchants.get(key) ?? {
      key,
      samples: [],
      amounts: [],
      dates: [],
      accounts: new Set<string>(),
      notes: [],
    }
    if (m.samples.length < 5 && !m.samples.includes(r.description)) m.samples.push(r.description)
    if (r.notes && m.notes.length < 3 && !m.notes.includes(r.notes)) m.notes.push(r.notes)
    m.amounts.push(r.amount)
    m.dates.push(r.date)
    m.accounts.add(`${r.account} (${r.accountType.replace("_", " ")})`)
    merchants.set(key, m)
  }
  if (merchants.size === 0) {
    return { byRules, merchantsAsked: 0, byAi: 0, remaining: 0 }
  }

  const cats = await must<Pick<Category, "id" | "name" | "kind">[]>(
    db.from("categories").select("id, name, kind").order("kind").order("name")
  )
  if (cats.length === 0) throw new Error("Add some categories first")

  // The user's own decisions are the best guide to their conventions.
  const examples = await must<Context["examples"]>(
    db
      .from("rules")
      .select("merchant:pattern, note, ...categories!inner(category:name)")
      .neq("source", "ai")
      .order("created_at", { ascending: false })
      .limit(150)
  )
  const fmt = Object.fromEntries(
    (await must<{ key: string; value: string }[]>(db.from("settings").select("key, value"))).map(
      (r) => [r.key, r.value]
    )
  )
  const ctx: Context = {
    categories: cats,
    examples,
    currency: fmt.currency ?? "USD",
    country: countryFromLocale(fmt.locale ?? "en-US"),
  }

  const client = await anthropicClient()
  const list = [...merchants.values()]
  const batches: Merchant[][] = []
  for (let i = 0; i < list.length; i += BATCH_SIZE) batches.push(list.slice(i, i + BATCH_SIZE))

  // Batches run in parallel; a failed one doesn't discard the others.
  const settled = await Promise.allSettled(batches.map((b) => classifyBatch(client, ctx, b)))
  const errors: string[] = []
  for (const res of settled) {
    if (res.status === "rejected") {
      console.error(res.reason)
      errors.push(describeError(res.reason))
      continue
    }
    for (const a of res.value) {
      await upsertMerchantRule(db, a.key, {
        categoryId: a.categoryId,
        source: "ai",
        confidence: a.confidence,
        reason: a.reason,
      })
    }
  }

  const byAi = await applyRulesToUncategorized(db)
  if (errors.length > 0 && byAi === 0) throw new Error(errors[0])
  return { byRules, merchantsAsked: list.length, byAi, remaining: rows.length - byAi }
}

export function describeError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic API key is missing or invalid. Check it in Settings."
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API, try again shortly"
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API"
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`
  return err instanceof Error ? err.message : "Auto-categorization failed"
}
