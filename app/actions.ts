"use server"

import { createHash } from "node:crypto"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { z } from "zod"

import {
  ACCOUNT_TYPES,
  CATEGORY_KINDS,
  type PlanMessage,
  type PlanThread,
  type RuleKind,
  type RuleSource,
} from "@/lib/db/schema"
import {
  applyRulesToUncategorized,
  autoCategorize,
  getAllRules,
  setCategories,
  syncRuleTransactions,
  upsertMerchantRule,
} from "@/lib/categorize"
import {
  AKAHU_APP_TOKEN_SETTING,
  AKAHU_USER_TOKEN_SETTING,
  accountType,
  akahuClient,
  runAkahuSync,
  setAkahuIgnored,
} from "@/lib/akahu"
import { API_KEY_SETTING } from "@/lib/anthropic"
import { runCheckIn } from "@/lib/checkin"
import {
  COLUMNS,
  DbError,
  getDb,
  getUserId,
  must,
  selectAll,
  type Db,
} from "@/lib/db"
import { deleteStored, readStoredRows } from "@/lib/import/files"
import { applyMapping, detectStatementInfo, type Mapping } from "@/lib/import/parse"
import { FREQUENCIES, type Frequency } from "@/lib/plan"
import {
  continuePlan,
  loadSnapshot,
  startPlan,
  type NewTurn,
} from "@/lib/planner"
import { RECURRING_BASES } from "@/lib/recurring"
import { buildMatcher, merchantKey } from "@/lib/rules"

// Actions act as the signed-in user: the Supabase client carries their session, and row
// level security limits every query to their rows. Signed out, they see and change nothing.

export type ActionResult<T = object> =
  ({ ok: true } & T) | { ok: false; error: string }

async function run<T extends object>(
  fn: () => Promise<T>
): Promise<ActionResult<T>> {
  try {
    const out = await fn()
    revalidatePath("/", "layout")
    return { ok: true, ...out }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues.map((i) => i.message).join(", ") }
    }
    console.error(err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Something went wrong",
    }
  }
}

const optionalText = z
  .string()
  .trim()
  .transform((s) => s || null)
  .nullable()
  .optional()

const money = z.coerce.number({ message: "Enter a valid amount" }).finite()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
const id = z.coerce.number().int().positive()
const optionalId = z
  .union([z.literal(""), z.literal("none"), z.null(), z.undefined(), id])
  .transform((v) => (typeof v === "number" ? v : null))

function fields(form: FormData) {
  return Object.fromEntries(form.entries())
}

/** Insert one row and return its id. */
async function insertId(db: Db, table: string, row: object) {
  return (
    await must<{ id: number }>(db.from(table).insert(row).select("id").single())
  ).id
}

// ── Accounts ────────────────────────────────────────────────────────────────

const accountSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  type: z.enum(ACCOUNT_TYPES),
  institution: optionalText,
  openingBalance: money.default(0),
})

export async function saveAccount(form: FormData) {
  return run(async () => {
    const { openingBalance, ...data } = accountSchema.parse(fields(form))
    const row = { ...data, opening_balance: openingBalance }
    const db = await await getDb()
    const accountId = form.get("id") ? id.parse(form.get("id")) : null
    if (accountId) {
      await must(db.from("accounts").update(row).eq("id", accountId))
      return { id: accountId }
    }
    return { id: await insertId(db, "accounts", row) }
  })
}

/**
 * Match an account to the bank: set its opening balance so the opening balance plus every
 * transaction up to `asOf` (default: all of them) equals the bank's balance on that day.
 */
export async function reconcileAccount(accountId: number, balance: number, asOf?: string) {
  return run(async () => {
    accountId = id.parse(accountId)
    balance = money.parse(balance)
    const db = await getDb()
    const [account] = await must<
      { openingBalance: number; akahuId: string | null; akahuStart: string | null }[]
    >(
      db
        .from("accounts")
        .select("openingBalance:opening_balance, akahuId:akahu_id, akahuStart:akahu_start")
        .eq("id", accountId)
    )
    if (!account) throw new Error("Account not found")

    const amounts = await selectAll<{ amount: number }>((from, to) => {
      let query = db.from("transactions").select("amount").eq("account_id", accountId)
      if (asOf) query = query.lte("date", isoDate.parse(asOf))
      return query.order("id").range(from, to)
    })
    const total = amounts.reduce((s, r) => s + Number(r.amount), 0)
    const openingBalance = Math.round((balance - total) * 100) / 100
    await must(db.from("accounts").update({ opening_balance: openingBalance }).eq("id", accountId))

    const previous = Number(account.openingBalance)
    return {
      previousOpeningBalance: previous,
      openingBalance,
      adjustment: Math.round((openingBalance - previous) * 100) / 100,
      transactionsCounted: amounts.length,
      // The hourly sync matches these to Akahu's balance itself (supabase/functions/akahu-sync).
      overwrittenBySync: account.akahuId !== null && account.akahuStart === null,
    }
  })
}

export async function setAccountArchived(accountId: number, archived: boolean) {
  return run(async () => {
    await must(
      (await getDb())
        .from("accounts")
        .update({ archived })
        .eq("id", id.parse(accountId))
    )
    return {}
  })
}

export async function deleteAccount(accountId: number) {
  return run(async () => {
    const db = await await getDb()
    const files = await must<{ storedName: string }[]>(
      db
        .from("statements")
        .select("storedName:stored_name")
        .eq("account_id", id.parse(accountId))
    )
    const [deleted] = await must<{ akahuId: string | null }[]>(
      db.from("accounts").delete().eq("id", accountId).select("akahuId:akahu_id")
    )
    await deleteStored(...files.map((f) => f.storedName))
    // Deleting a synced account means you don't want it; the sync would otherwise re-add it.
    if (deleted?.akahuId) await setAkahuIgnored(db, deleted.akahuId, true)
    return {}
  })
}

// ── Transactions ────────────────────────────────────────────────────────────

const txSchema = z.object({
  accountId: id,
  date: isoDate,
  description: z.string().trim().min(1, "Description is required"),
  amount: money,
  categoryId: optionalId,
  notes: optionalText,
})

export async function saveTransaction(form: FormData) {
  return run(async () => {
    const data = txSchema.parse(fields(form))
    const row = {
      account_id: data.accountId,
      date: data.date,
      description: data.description,
      amount: data.amount,
      category_id: data.categoryId,
      notes: data.notes,
    }
    const db = await await getDb()
    const txId = form.get("id") ? id.parse(form.get("id")) : null
    if (txId) {
      const [before] = await must<{ categoryId: number | null }[]>(
        db.from("transactions").select("categoryId:category_id").eq("id", txId)
      )
      const changed = before && before.categoryId !== data.categoryId
      await must(
        db
          .from("transactions")
          .update({
            ...row,
            ...(changed ? manualCategory(data.categoryId) : {}),
          })
          .eq("id", txId)
      )
      const updatedSimilar = changed
        ? await learn(db, data.description, data.categoryId)
        : 0
      return { id: txId, updatedSimilar }
    }
    const newId = await insertId(db, "transactions", {
      ...row,
      ...manualCategory(data.categoryId),
      source: "manual",
    })
    return { id: newId, updatedSimilar: 0 }
  })
}

/** A category you chose by hand: never overwritten by rules or the LLM. */
function manualCategory(categoryId: number | null) {
  return {
    category_id: categoryId,
    rule_id: null,
    category_source: "manual" as const,
    category_confidence: categoryId === null ? null : 100,
  }
}

/**
 * Remember a correction as a merchant rule at 100% confidence, move the
 * other auto-categorized transactions of that merchant along with it, and
 * pick up any uncategorized ones. Returns how many other rows changed.
 */
async function learn(db: Db, description: string, categoryId: number | null) {
  if (categoryId === null) return 0
  const ruleId = await upsertMerchantRule(db, merchantKey(description), {
    categoryId,
    source: "learned",
    confidence: 100,
  })
  return (
    (await syncRuleTransactions(db, ruleId)) +
    (await applyRulesToUncategorized(db))
  )
}

export async function setTransactionCategory(
  txId: number,
  categoryId: number | null
) {
  return run(async () => {
    const db = await await getDb()
    const catId = optionalId.parse(categoryId)
    const [tx] = await must<{ description: string }[]>(
      db
        .from("transactions")
        .update(manualCategory(catId))
        .eq("id", id.parse(txId))
        .select("description")
    )
    if (!tx) throw new Error("Transaction not found")
    return { updatedSimilar: await learn(db, tx.description, catId) }
  })
}

export async function deleteTransaction(txId: number) {
  return run(async () => {
    await must(
      (await getDb()).from("transactions").delete().eq("id", id.parse(txId))
    )
    return {}
  })
}

// ── Categories & rules ──────────────────────────────────────────────────────

const categorySchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  kind: z.enum(CATEGORY_KINDS),
  monthlyBudget: z
    .union([z.literal(""), money.nonnegative()])
    .optional()
    .transform((v) => (v === "" || v === undefined || v === 0 ? null : v)),
})

export async function saveCategory(form: FormData) {
  return run(async () => {
    const data = categorySchema.parse(fields(form))
    const row = {
      name: data.name,
      kind: data.kind,
      monthly_budget: data.monthlyBudget,
    }
    const db = await await getDb()
    const catId = form.get("id") ? id.parse(form.get("id")) : null
    try {
      if (catId) {
        await must(db.from("categories").update(row).eq("id", catId))
        return { id: catId }
      }
      return { id: await insertId(db, "categories", row) }
    } catch (err) {
      // unique_violation
      if (err instanceof DbError && err.code === "23505") {
        throw new Error(`A category named “${data.name}” already exists`)
      }
      throw err
    }
  })
}

export async function deleteCategory(catId: number) {
  return run(async () => {
    await must(
      (await getDb()).from("categories").delete().eq("id", id.parse(catId))
    )
    return {}
  })
}

const ruleSchema = z.object({
  pattern: z.string().trim().min(2, "Pattern needs at least 2 characters"),
  categoryId: id,
})

export async function createRule(form: FormData) {
  return run(async () => {
    const data = ruleSchema.parse(fields(form))
    await must(
      (await getDb())
        .from("rules")
        .insert({ pattern: data.pattern, category_id: data.categoryId })
    )
    const applied =
      form.get("applyNow") === "on" ? await applyRulesToUncategorized() : 0
    return { applied }
  })
}

export async function deleteRule(ruleId: number) {
  return run(async () => {
    await must(
      (await getDb()).from("rules").delete().eq("id", id.parse(ruleId))
    )
    return {}
  })
}

export async function applyRules() {
  return run(async () => ({ applied: await applyRulesToUncategorized() }))
}

export async function resetRules() {
  return run(async () => {
    // PostgREST refuses a delete without a filter
    await must((await getDb()).from("rules").delete().gte("id", 0))
    return {}
  })
}

/** Rules first, then the LLM for whatever is left. */
export async function runAutoCategorize() {
  return run(() => autoCategorize())
}

/** Move a rule — and everything it auto-categorized — to another category. */
export async function recategorizeRule(ruleId: number, categoryId: number) {
  return run(async () => {
    const db = await await getDb()
    const [rule] = await must<{ id: number; kind: RuleKind }[]>(
      db
        .from("rules")
        .update({
          category_id: id.parse(categoryId),
          source: "learned",
          confidence: 100,
          reason: null,
        })
        .eq("id", id.parse(ruleId))
        .select("id, kind")
    )
    if (!rule) throw new Error("Rule not found")
    // A contains rule you wrote stays "manual"; only merchant rules are learned.
    if (rule.kind === "contains") {
      await must(
        db.from("rules").update({ source: "manual" }).eq("id", rule.id)
      )
    }
    return { updated: await syncRuleTransactions(db, rule.id) }
  })
}

/**
 * Categorize every uncategorized transaction of a merchant — including ones
 * you cleared by hand — and remember it as a learned rule.
 */
export async function categorizeMerchant(key: string, categoryId: number) {
  return run(async () => {
    const db = await await getDb()
    const catId = id.parse(categoryId)
    const merchant = z.string().trim().min(1).parse(key)
    const ruleId = await upsertMerchantRule(db, merchant, {
      categoryId: catId,
      source: "learned",
      confidence: 100,
    })
    const rows = await selectAll<{ id: number; description: string }>(
      (from, to) =>
        db
          .from("transactions")
          .select("id, description")
          .is("category_id", null)
          .order("id")
          .range(from, to)
    )
    const ids = rows
      .filter((r) => merchantKey(r.description) === merchant)
      .map((r) => r.id)
    const updated =
      ids.length > 0
        ? await setCategories(db, ids, {
            categoryId: catId,
            ruleId,
            source: "rule",
            confidence: 100,
          })
        : 0
    // The new rule may also fuzzy-match other uncategorized merchants.
    return { updated: updated + (await applyRulesToUncategorized(db)) }
  })
}

export async function setRuleNote(ruleId: number, note: string) {
  return run(async () => {
    await must(
      (await getDb())
        .from("rules")
        .update({ note: optionalText.parse(note) ?? null })
        .eq("id", id.parse(ruleId))
    )
    return {}
  })
}

/** Accept a rule's category as correct: confidence becomes 100%. */
export async function confirmRule(ruleId: number) {
  return run(async () => {
    const db = await await getDb()
    const [rule] = await must<{ id: number; source: RuleSource }[]>(
      db
        .from("rules")
        .update({ confidence: 100 })
        .eq("id", id.parse(ruleId))
        .select("id, source")
    )
    if (!rule) throw new Error("Rule not found")
    if (rule.source === "ai") {
      await must(
        db.from("rules").update({ source: "learned" }).eq("id", rule.id)
      )
    }
    return { updated: await syncRuleTransactions(db, rule.id) }
  })
}

// ── Statement import ────────────────────────────────────────────────────────

export async function commitImport(input: {
  storedName: string
  fileName: string
  accountId: number
  mapping: Mapping
  /** skip rows on dates this account already has transactions for */
  onlyNewDates?: boolean
}) {
  return run(async () => {
    const db = await await getDb()
    const accountId = id.parse(input.accountId)
    const rows = await readStoredRows(input.storedName)
    const { parsed, skipped } = applyMapping(rows, input.mapping)
    if (parsed.length === 0)
      throw new Error("No transactions found with this mapping")

    const match = buildMatcher(await getAllRules(db))
    const seen = new Map<string, number>()
    const values = parsed.map((r) => {
      const base = `${r.date}|${r.amount.toFixed(2)}|${r.description.toLowerCase()}`
      // Identical rows within one statement are real, separate transactions.
      const occurrence = (seen.get(base) ?? 0) + 1
      seen.set(base, occurrence)
      const m = match(r.description)
      return {
        account_id: accountId,
        date: r.date,
        description: r.description,
        amount: r.amount,
        category_id: m?.categoryId ?? null,
        rule_id: m?.ruleId ?? null,
        category_source: m?.source ?? null,
        category_confidence: m?.confidence ?? null,
        hash: createHash("sha1").update(`${base}|${occurrence}`).digest("hex"),
      }
    })
    const dates = parsed.map((r) => r.date).sort()

    // Hashes above are computed over the whole file, so filtering afterwards keeps them stable.
    let toInsert = values
    if (input.onlyNewDates) {
      const existing = await selectAll<{ date: string }>((from, to) =>
        db
          .from("transactions")
          .select("date")
          .eq("account_id", accountId)
          .gte("date", dates[0])
          .lte("date", dates[dates.length - 1])
          .order("id")
          .range(from, to)
      )
      const known = new Set(existing.map((e) => e.date))
      toInsert = values.filter((v) => !known.has(v.date))
    }
    const existingDates = values.length - toInsert.length

    // One database transaction; a statement with nothing new isn't kept, so it doesn't
    // clutter the history with an empty import.
    const [{ inserted, categorized }] = await must<
      { inserted: number; categorized: number }[]
    >(
      db.rpc("import_statement", {
        p_statement: {
          account_id: accountId,
          file_name: input.fileName,
          stored_name: input.storedName,
          row_count: parsed.length,
          period_start: dates[0],
          period_end: dates[dates.length - 1],
          // lets the Akahu sync recognise this account (see accountNumberKey)
          account_number:
            detectStatementInfo(rows, input.mapping.headerRow).account ??
            input.fileName.match(/\d{2}-\d{4}-\d{5,8}-\d{2,3}/)?.[0] ??
            null,
        },
        p_rows: toInsert,
      })
    )
    const result = {
      inserted,
      existingDates,
      duplicates: toInsert.length - inserted,
      skipped: skipped.length,
      categorized,
    }
    if (result.inserted === 0) await deleteStored(input.storedName)

    // Rules already ran above; ask the LLM only about what's still left.
    // Best effort: the import itself has succeeded either way.
    let aiCategorized = 0
    let aiError: string | null = null
    if (result.inserted > result.categorized) {
      try {
        aiCategorized = (await autoCategorize()).byAi
      } catch (err) {
        aiError =
          err instanceof Error ? err.message : "Auto-categorization failed"
      }
    }
    return { ...result, aiCategorized, aiError }
  })
}

// ── Akahu bank feeds ────────────────────────────────────────────────────────

const akahuTokensSchema = z.object({
  appToken: z
    .string()
    .trim()
    .startsWith("app_token_", "The App ID Token starts with app_token_"),
  userToken: z
    .string()
    .trim()
    .startsWith("user_token_", "The User Access Token starts with user_token_"),
})

export async function saveAkahuTokens(form: FormData) {
  return run(async () => {
    const { appToken, userToken } = akahuTokensSchema.parse(fields(form))
    await must(
      (await getDb()).from("settings").upsert([
        { key: AKAHU_APP_TOKEN_SETTING, value: appToken },
        { key: AKAHU_USER_TOKEN_SETTING, value: userToken },
      ])
    )
    return {}
  })
}

export async function removeAkahuTokens() {
  return run(async () => {
    await must(
      (await getDb())
        .from("settings")
        .delete()
        .in("key", [AKAHU_APP_TOKEN_SETTING, AKAHU_USER_TOKEN_SETTING])
    )
    return {}
  })
}

/**
 * Link an Akahu account to one of yours ("new" creates it), or unlink it (null).
 * Linking an account that already has transactions only syncs ones after its latest,
 * so statements imported before don't come in twice.
 */
export async function linkAkahuAccount(akahuId: string, target: "new" | number | null) {
  return run(async () => {
    const db = await getDb()
    akahuId = z.string().startsWith("acc_").parse(akahuId)
    await must(
      db.from("accounts").update({ akahu_id: null, akahu_start: null }).eq("akahu_id", akahuId)
    )
    // Remembered, so the next sync doesn't add an account for it again.
    await setAkahuIgnored(db, akahuId, target === null)
    if (target === null) return { synced: 0, syncError: null }

    const akahu = await akahuClient(db)
    const source = (await akahu.accounts()).find((a) => a._id === akahuId)
    if (!source) throw new Error("That account isn't connected in Akahu any more")

    let accountId: number
    if (target === "new") {
      accountId = await insertId(db, "accounts", {
        name: source.name,
        type: accountType(source.type),
        institution: source.connection.name,
        akahu_id: akahuId,
      })
    } else {
      accountId = id.parse(target)
      const [latest] = await must<{ date: string }[]>(
        db
          .from("transactions")
          .select("date")
          .eq("account_id", accountId)
          .order("date", { ascending: false })
          .limit(1)
      )
      await must(
        db
          .from("accounts")
          .update({ akahu_id: akahuId, akahu_start: latest?.date ?? null })
          .eq("id", accountId)
      )
    }
    // The link is saved either way; a failed first sync is retried by the next one.
    try {
      const { inserted, failed } = await runAkahuSync(db, accountId)
      return { synced: inserted, syncError: failed[0]?.error ?? null }
    } catch (err) {
      return { synced: 0, syncError: err instanceof Error ? err.message : "Sync failed" }
    }
  })
}

/**
 * Pull new transactions into every linked account, adding accounts for Akahu ones that
 * have none (the akahu-sync edge function does this hourly too), then let the LLM
 * categorize what the rules didn't.
 */
export async function syncAkahu() {
  return run(async () => {
    const db = await getDb()
    const { inserted, categorized, failed, created, matched } = await runAkahuSync(db)

    // Best effort, as with statement imports: the sync has succeeded either way.
    let aiCategorized = 0
    let aiError: string | null = null
    if (inserted > categorized) {
      try {
        aiCategorized = (await autoCategorize()).byAi
      } catch (err) {
        aiError = err instanceof Error ? err.message : "Auto-categorization failed"
      }
    }
    return {
      inserted,
      categorized,
      aiCategorized,
      aiError,
      failedAccounts: failed.length,
      addedAccounts: created + matched,
    }
  })
}

export async function deleteStatement(statementId: number) {
  return run(async () => {
    const [stmt] = await must<{ storedName: string }[]>(
      (await getDb())
        .from("statements")
        .delete()
        .eq("id", id.parse(statementId))
        .select("storedName:stored_name")
    )
    if (stmt) await deleteStored(stmt.storedName)
    return {}
  })
}

// ── Recurring & budgets ─────────────────────────────────────────────────────

const projectionFields = {
  basis: z.union([z.literal("default"), z.enum(RECURRING_BASES)]),
  /** percent per year, blank to inherit */
  growthRate: z
    .union([
      z.literal(""),
      z.coerce.number({ message: "Enter a valid growth rate" }).finite(),
    ])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v / 100)),
  amount: z
    .union([z.literal(""), money.nonnegative()])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
}

const needsAmount = <T extends { basis: string; amount: number | null }>(
  v: T
) => v.basis !== "custom" || v.amount !== null
const amountMessage = { message: "Enter a monthly amount for the custom basis" }

const recurringSchema = z
  .object({
    key: z.string().min(1),
    ...projectionFields,
    excluded: z
      .literal("on")
      .optional()
      .transform((v) => v === "on"),
  })
  .refine(needsAmount, amountMessage)

const categoryProjectionSchema = z
  .object({ categoryId: id, ...projectionFields })
  .refine(needsAmount, amountMessage)

export async function saveCategoryProjection(form: FormData) {
  return run(async () => {
    const { categoryId, basis, growthRate, amount } =
      categoryProjectionSchema.parse(fields(form))
    await must(
      (await getDb()).from("category_projections").upsert({
        category_id: categoryId,
        basis: basis === "default" ? null : basis,
        growth_rate: growthRate,
        amount,
        updated_at: new Date().toISOString(),
      })
    )
    return {}
  })
}

export async function resetCategoryProjection(categoryId: number) {
  return run(async () => {
    await must(
      (await getDb())
        .from("category_projections")
        .delete()
        .eq("category_id", id.parse(categoryId))
    )
    return {}
  })
}

export async function saveRecurringOverride(form: FormData) {
  return run(async () => {
    const { key, basis, growthRate, amount, excluded } = recurringSchema.parse(
      fields(form)
    )
    await must(
      (await getDb()).from("recurring_overrides").upsert({
        key,
        basis: basis === "default" ? null : basis,
        growth_rate: growthRate,
        amount,
        excluded,
        updated_at: new Date().toISOString(),
      })
    )
    return {}
  })
}

export async function resetRecurringOverride(key: string) {
  return run(async () => {
    await must(
      (await getDb())
        .from("recurring_overrides")
        .delete()
        .eq("key", z.string().parse(key))
    )
    return {}
  })
}

const budgetsSchema = z
  .array(z.object({ categoryId: id, amount: money.nonnegative() }))
  .min(1, "Nothing to apply")

/** Set monthly budgets on expense categories, e.g. from the recurring projection. */
export async function setCategoryBudgets(
  input: { categoryId: number; amount: number }[]
) {
  return run(async () => {
    const list = budgetsSchema.parse(input)
    await must(
      (await getDb()).rpc("set_category_budgets", {
        p_budgets: list.map((b) => ({
          category_id: b.categoryId,
          amount: b.amount,
        })),
      })
    )
    return { count: list.length }
  })
}

// ── Settings ────────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code"),
  locale: z.string().trim().min(2),
})

export async function saveSettings(form: FormData) {
  return run(async () => {
    const data = settingsSchema.parse(fields(form))
    try {
      new Intl.NumberFormat(data.locale, {
        style: "currency",
        currency: data.currency,
      })
    } catch {
      throw new Error("Unsupported currency or locale")
    }
    await must(
      (await getDb())
        .from("settings")
        .upsert(Object.entries(data).map(([key, value]) => ({ key, value })))
    )
    return {}
  })
}

const apiKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .startsWith("sk-ant-", "That doesn't look like an Anthropic API key"),
})

export async function saveApiKey(form: FormData) {
  return run(async () => {
    const { apiKey } = apiKeySchema.parse(fields(form))
    await must(
      (await getDb())
        .from("settings")
        .upsert({ key: API_KEY_SETTING, value: apiKey })
    )
    return {}
  })
}

export async function removeApiKey() {
  return run(async () => {
    await must(
      (await getDb()).from("settings").delete().eq("key", API_KEY_SETTING)
    )
    return {}
  })
}

// ── Plan ────────────────────────────────────────────────────────────────────

async function saveTurn(db: Db, threadId: number, turn: NewTurn) {
  await must(
    db.from("plan_messages").insert([
      {
        thread_id: threadId,
        role: "user",
        content: turn.user.content,
        context: turn.user.context || null,
      },
      {
        thread_id: threadId,
        role: "assistant",
        content: turn.assistant.content,
        plan: turn.assistant.plan,
      },
    ])
  )
}

/** Start a new planning conversation from your current data. */
export async function createPlan(goals: string, frequency: Frequency) {
  return run(async () => {
    const snapshot = await loadSnapshot()
    if (!snapshot) throw new Error("Import some transactions first")
    const turn = await startPlan(
      snapshot,
      z.string().trim().max(4000).parse(goals),
      z.enum(FREQUENCIES).parse(frequency)
    )
    const db = await await getDb()
    await saveTurn(db, await insertId(db, "plan_threads", { snapshot }), turn)
    return {}
  })
}

/** Ask the planner a question or for a change, in the latest conversation. */
export async function askPlanner(threadId: number, message: string) {
  return run(async () => {
    const text = z
      .string()
      .trim()
      .min(1, "Write a message")
      .max(4000)
      .parse(message)
    const db = await await getDb()
    const [thread] = await must<PlanThread[]>(
      db
        .from("plan_threads")
        .select(COLUMNS.planThreads)
        .eq("id", id.parse(threadId))
    )
    if (!thread) throw new Error("That plan no longer exists")
    const messages = await must<PlanMessage[]>(
      db
        .from("plan_messages")
        .select(COLUMNS.planMessages)
        .eq("thread_id", threadId)
        .order("id")
    )
    const turn = await continuePlan(thread.snapshot, messages, text)
    await saveTurn(db, threadId, turn)
    return { changed: turn.assistant.plan !== null }
  })
}

// ── Log: upcoming expenses & check-ins ──────────────────────────────────────

const upcomingSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  amount: money.positive("Enter an amount above zero"),
  dueDate: isoDate,
  accountId: optionalId,
  note: optionalText,
})

export async function saveUpcomingExpense(form: FormData) {
  return run(async () => {
    const data = upcomingSchema.parse(fields(form))
    const row = {
      name: data.name,
      amount: data.amount,
      due_date: data.dueDate,
      account_id: data.accountId,
      note: data.note,
    }
    const db = await await getDb()
    const expenseId = form.get("id") ? id.parse(form.get("id")) : null
    if (expenseId) {
      await must(db.from("upcoming_expenses").update(row).eq("id", expenseId))
      return { id: expenseId }
    }
    return { id: await insertId(db, "upcoming_expenses", row) }
  })
}

export async function deleteUpcomingExpense(expenseId: number) {
  return run(async () => {
    await must(
      (await getDb())
        .from("upcoming_expenses")
        .delete()
        .eq("id", id.parse(expenseId))
    )
    return {}
  })
}

/** Analyse what was logged since the last check-in and ask the model what to do. */
export async function checkIn() {
  return run(() => runCheckIn())
}

// ── Auth ────────────────────────────────────────────────────────────────────

const signInSchema = z.object({
  email: z.string().trim().email("Enter your email address"),
  password: z.string().min(1, "Enter your password"),
})

export async function signIn(form: FormData) {
  return run(async () => {
    const { error } = await (
      await getDb()
    ).auth.signInWithPassword(signInSchema.parse(fields(form)))
    if (error) throw new Error(error.message)
    return {}
  })
}

export async function signOut() {
  return run(async () => {
    const { error } = await (await getDb()).auth.signOut()
    if (error) throw new Error(error.message)
    return {}
  })
}

const resetRequestSchema = z.object({
  email: z.string().trim().email("Enter your email address"),
})

/**
 * Email a password reset link. Supabase only sends it to existing users and answers the
 * same either way, so this never reveals whether an address has an account.
 */
export async function requestPasswordReset(form: FormData) {
  return run(async () => {
    const { email } = resetRequestSchema.parse(fields(form))
    const origin = (await headers()).get("origin")
    if (!origin) throw new Error("Couldn't tell which site to link back to")
    const { error } = await (
      await getDb()
    ).auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/confirm?next=/reset-password`,
    })
    if (error) {
      console.error(error)
      // Supabase's own messages here are about its mail setup, not something the user can fix.
      throw new Error(
        error.status === 429
          ? "A reset email was sent recently. Wait a minute, then try again."
          : "Couldn't send the reset email. Try again later."
      )
    }
    return {}
  })
}

const newPasswordSchema = z
  .object({
    password: z.string().min(8, "Use at least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "The passwords don't match",
  })

/** Set a new password for the signed-in user (including one signed in by a reset link). */
export async function updatePassword(form: FormData) {
  return run(async () => {
    const db = await getDb()
    await getUserId(db)
    const { password } = newPasswordSchema.parse(fields(form))
    const { error } = await db.auth.updateUser({ password })
    if (error) throw new Error(error.message)
    return {}
  })
}

// ── Connected apps (OAuth) ──────────────────────────────────────────────────

/**
 * Approve or deny an app's request (e.g. claude.ai's MCP connector) to act as you, from the
 * consent page Supabase's OAuth server sends you to. Returns where to send you back to.
 */
export async function decideAuthorization(authorizationId: string, approve: boolean) {
  return run(async () => {
    const oauth = (await getDb()).auth.oauth
    const { data, error } = approve
      ? await oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      : await oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
    if (error) throw new Error(error.message)
    return { redirectUrl: data.redirect_url }
  })
}
