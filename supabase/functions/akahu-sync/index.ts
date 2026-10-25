// Pull new Akahu transactions into linked accounts and categorize them with your rules.
//
// Called two ways:
// - by the app (Sync now, or right after linking an account) with the signed-in user's
//   access token: syncs that user, or only `accountId` when the body names one;
// - by the hourly pg_cron job (supabase/migrations) with AKAHU_CRON_SECRET: syncs every
//   user with a linked account or saved tokens, or only `userId` when the body names one.
//   A user relying on the AKAHU_* env tokens gets their accounts added by their first
//   Sync now; after that the job keeps them synced.
//
// Each account's run is logged in akahu_syncs with the exact window asked for; the next
// run resumes from its end. It acts with the service role, so every query filters by
// user_id itself. AI
// categorization stays in the app (lib/categorize.ts); it runs after a manual sync.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2.118.0"

import {
  AKAHU_IGNORED_SETTING,
  accountNumberKey,
  accountType,
  akahuApi,
  daysBefore,
  localDate,
  type AkahuAccount,
  type AkahuApi,
  type AkahuTokens,
} from "../_shared/akahu.ts"
import { buildMatcher, type RuleLike } from "../_shared/rules.ts"

/** Re-read this many days before the last synced transaction, for ones the bank posts late. */
const OVERLAP_DAYS = 7
const DAY = 24 * 60 * 60 * 1000
// The API returns at most this many rows per request (Supabase's default max_rows).
const PAGE = 1000

// Setting keys, as in lib/akahu.ts.
const APP_TOKEN_SETTING = "akahuAppToken"
const USER_TOKEN_SETTING = "akahuUserToken"

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

type Result = { data: unknown; error: { message: string } | null }

async function must<T>(query: PromiseLike<Result>): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data as T
}

/** Every row of a query that may exceed the API's row limit. The query must have a stable order. */
async function selectAll<T>(page: (from: number, to: number) => PromiseLike<Result>) {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = await must<T[]>(page(from, from + PAGE - 1))
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

type LinkedAccount = { id: number; akahuId: string; akahuStart: string | null }

/** The user's tokens saved in Settings, else AKAHU_APP_TOKEN and AKAHU_USER_TOKEN. */
async function tokensFor(userId: string): Promise<AkahuTokens> {
  const rows = await must<{ key: string; value: string }[]>(
    db
      .from("settings")
      .select("key, value")
      .eq("user_id", userId)
      .in("key", [APP_TOKEN_SETTING, USER_TOKEN_SETTING])
  )
  const get = (key: string) => rows.find((r) => r.key === key)?.value
  const appToken = get(APP_TOKEN_SETTING) ?? Deno.env.get("AKAHU_APP_TOKEN")
  const userToken = get(USER_TOKEN_SETTING) ?? Deno.env.get("AKAHU_USER_TOKEN")
  if (!appToken || !userToken) throw new Error("Add your Akahu tokens in Settings to sync bank feeds")
  return { appToken, userToken }
}

type RunBy = "app" | "schedule"
type Window = { start: string; end: string }
const EPOCH = new Date(0).toISOString()

/**
 * The window to ask Akahu for: from the end of the last successful sync, less the
 * overlap, up to now. The first sync takes all history, or what's after the link date.
 */
async function syncWindow(account: LinkedAccount): Promise<Window> {
  const end = new Date().toISOString()
  const [last] = await must<{ range_end: string }[]>(
    db
      .from("akahu_syncs")
      .select("range_end")
      .eq("account_id", account.id)
      .eq("akahu_account_id", account.akahuId)
      .not("finished_at", "is", null)
      .is("error", null)
      .order("range_end", { ascending: false })
      .limit(1)
  )
  if (last) {
    return { start: new Date(Date.parse(last.range_end) - OVERLAP_DAYS * DAY).toISOString(), end }
  }
  // start is exclusive and in UTC; reach back a day so the whole NZ day is covered.
  // Akahu wants a start whenever there's an end, so "all history" is from the epoch.
  return { start: account.akahuStart ? daysBefore(account.akahuStart, 1) : EPOCH, end }
}

/**
 * The window's transactions to add: after the link date, and not already stored under
 * their pre-migration id. Ones already stored under their own id are skipped on insert.
 */
async function fetchTransactions(akahu: AkahuApi, account: LinkedAccount, window: Window) {
  const items = await akahu.transactions(account.akahuId, window.start, window.end)
  const rows = items
    .map((t) => ({ ...t, day: localDate(t.date) }))
    .filter((t) => !account.akahuStart || t.day > account.akahuStart)

  const migrated = rows.flatMap((t) => (t._migrated ? [t._migrated] : []))
  const known = new Set<string>()
  for (let i = 0; i < migrated.length; i += 500) {
    const found = await must<{ hash: string }[]>(
      db
        .from("transactions")
        .select("hash")
        .eq("account_id", account.id)
        .in("hash", migrated.slice(i, i + 500))
    )
    for (const f of found) known.add(f.hash)
  }
  return { fetched: items.length, rows: rows.filter((t) => !t._migrated || !known.has(t._migrated)) }
}

/**
 * Give every Akahu account an account of yours to sync into. It links to one that isn't
 * linked yet whose imported statements name the same account number, else to one with
 * the same name and bank, else it creates one like it. Accounts already linked (archived
 * ones too) and ones you chose not to sync are left alone.
 */
async function adoptAccounts(userId: string, akahuAccounts: AkahuAccount[]) {
  const accounts = await selectAll<{
    id: number
    name: string
    institution: string | null
    akahuId: string | null
    archived: boolean
  }>((from, to) =>
    db
      .from("accounts")
      .select("id, name, institution, akahuId:akahu_id, archived")
      .eq("user_id", userId)
      .order("id")
      .range(from, to)
  )
  const [setting] = await must<{ value: string }[]>(
    db
      .from("settings")
      .select("value")
      .eq("user_id", userId)
      .eq("key", AKAHU_IGNORED_SETTING)
  )
  const ignored = new Set<string>(setting ? JSON.parse(setting.value) : [])
  const statements = await selectAll<{ accountId: number; number: string }>((from, to) =>
    db
      .from("statements")
      .select("accountId:account_id, number:account_number")
      .eq("user_id", userId)
      .not("account_number", "is", null)
      .order("id")
      .range(from, to)
  )
  const numbers = new Map<number, Set<string>>()
  for (const st of statements) {
    const key = accountNumberKey(st.number)
    if (!key) continue
    numbers.set(st.accountId, (numbers.get(st.accountId) ?? new Set()).add(key))
  }
  const claimed = new Set(accounts.flatMap((a) => (a.akahuId ? [a.akahuId] : [])))
  const same = (a: string | null, b: string) => a?.trim().toLowerCase() === b.trim().toLowerCase()

  let created = 0
  let matched = 0
  for (const a of akahuAccounts) {
    if (!a.attributes.includes("TRANSACTIONS")) continue
    if (claimed.has(a._id) || (a._migrated && claimed.has(a._migrated))) continue
    if (ignored.has(a._id) || (a._migrated && ignored.has(a._migrated))) continue

    const open = accounts.filter((c) => !c.akahuId && !c.archived)
    const key = accountNumberKey(a.formatted_account)
    const byNumber = key ? open.filter((c) => numbers.get(c.id)?.has(key)) : []
    const candidates =
      byNumber.length > 0
        ? byNumber
        : open.filter(
            (c) =>
              same(c.name, a.name) &&
              (c.institution === null || same(c.institution, a.connection.name))
          )
    if (candidates.length === 1) {
      // Only sync what's after the transactions it already has, as when you link it.
      const [match] = candidates
      const [latest] = await must<{ date: string }[]>(
        db
          .from("transactions")
          .select("date")
          .eq("account_id", match.id)
          .order("date", { ascending: false })
          .limit(1)
      )
      await must(
        db
          .from("accounts")
          .update({ akahu_id: a._id, akahu_start: latest?.date ?? null })
          .eq("id", match.id)
      )
      match.akahuId = a._id
      matched++
    } else {
      await must(
        db.from("accounts").insert({
          user_id: userId,
          name: a.name,
          type: accountType(a.type),
          institution: a.connection.name,
          akahu_id: a._id,
        })
      )
      created++
    }
    claimed.add(a._id)
  }
  return { created, matched }
}

/**
 * Sync a user's linked, unarchived accounts (or just one), logging each account's run
 * in akahu_syncs. One account failing doesn't stop the others. Also returns how many
 * accounts were created or matched for Akahu accounts that had none.
 */
async function syncUser(userId: string, runBy: RunBy, onlyAccountId?: number) {
  const akahu = akahuApi(await tokensFor(userId))
  const akahuAccounts: AkahuAccount[] = await akahu.accounts()
  // A full sync first adds an account for any Akahu account without one.
  const adopted =
    onlyAccountId === undefined
      ? await adoptAccounts(userId, akahuAccounts)
      : { created: 0, matched: 0 }
  const linked = await selectAll<LinkedAccount>((from, to) => {
    let q = db
      .from("accounts")
      .select("id, akahuId:akahu_id, akahuStart:akahu_start")
      .eq("user_id", userId)
      .not("akahu_id", "is", null)
      .eq("archived", false)
    if (onlyAccountId !== undefined) q = q.eq("id", onlyAccountId)
    return q.order("id").range(from, to)
  })

  // Follow accounts Akahu moved to a new connection (classic → official open banking),
  // carrying their sync history over so they resume where they left off.
  for (const account of linked) {
    if (akahuAccounts.some((a) => a._id === account.akahuId)) continue
    const moved = akahuAccounts.find((a) => a._migrated === account.akahuId)
    if (!moved) continue
    await must(db.from("accounts").update({ akahu_id: moved._id }).eq("id", account.id))
    await must(
      db
        .from("akahu_syncs")
        .update({ akahu_account_id: moved._id })
        .eq("account_id", account.id)
        .eq("akahu_account_id", account.akahuId)
    )
    account.akahuId = moved._id
  }

  const rules = await selectAll<RuleLike>((from, to) =>
    db
      .from("rules")
      .select("id, pattern, categoryId:category_id, kind, source, confidence")
      .eq("user_id", userId)
      .order("id")
      .range(from, to)
  )
  const match = buildMatcher(rules)

  let inserted = 0
  let categorized = 0
  const failed: { accountId: number; error: string }[] = []
  for (const account of linked) {
    const window = await syncWindow(account)
    const { id: syncId } = await must<{ id: number }>(
      db
        .from("akahu_syncs")
        .insert({
          user_id: userId,
          account_id: account.id,
          akahu_account_id: account.akahuId,
          range_start: window.start,
          range_end: window.end,
          run_by: runBy,
        })
        .select("id")
        .single()
    )
    try {
      const { fetched, rows } = await fetchTransactions(akahu, account, window)
      let added = 0
      const values = rows.map((t) => {
        const m = match(t.description)
        return {
          user_id: userId,
          account_id: account.id,
          date: t.day,
          description: t.description.trim() || "(no description)",
          amount: Math.round(t.amount * 100) / 100,
          category_id: m?.categoryId ?? null,
          rule_id: m?.ruleId ?? null,
          category_source: m?.source ?? null,
          category_confidence: m?.confidence ?? null,
          source: "akahu",
          hash: t._id,
        }
      })
      for (let i = 0; i < values.length; i += PAGE) {
        const rowsAdded = await must<{ category_id: number | null }[]>(
          db
            .from("transactions")
            .upsert(values.slice(i, i + PAGE), {
              onConflict: "account_id,hash",
              ignoreDuplicates: true,
            })
            .select("category_id")
        )
        added += rowsAdded.length
        categorized += rowsAdded.filter((r) => r.category_id !== null).length
      }
      inserted += added

      // An account whose whole history comes from Akahu: set the opening balance so the
      // balance matches the bank's.
      const current = akahuAccounts.find((a) => a._id === account.akahuId)?.balance?.current
      if (account.akahuStart === null && current !== undefined) {
        const amounts = await selectAll<{ amount: number }>((from, to) =>
          db
            .from("transactions")
            .select("amount")
            .eq("account_id", account.id)
            .order("id")
            .range(from, to)
        )
        const total = amounts.reduce((s, r) => s + Number(r.amount), 0)
        await must(
          db
            .from("accounts")
            .update({ opening_balance: Math.round((current - total) * 100) / 100 })
            .eq("id", account.id)
        )
      }

      await must(
        db
          .from("akahu_syncs")
          .update({ finished_at: new Date().toISOString(), fetched, inserted: added })
          .eq("id", syncId)
      )
    } catch (err) {
      console.error(account.id, err)
      failed.push({ accountId: account.id, error: message(err) })
      await must(
        db
          .from("akahu_syncs")
          .update({ finished_at: new Date().toISOString(), error: message(err) })
          .eq("id", syncId)
      )
    }
  }
  return { inserted, categorized, failed, ...adopted }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status })
}

function message(err: unknown) {
  return err instanceof Error ? err.message : "Sync failed"
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405)
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
  const body = await req.json().catch(() => ({}))
  const cronSecret = Deno.env.get("AKAHU_CRON_SECRET")

  try {
    if (cronSecret && token === cronSecret) {
      // Everyone with a linked account or saved tokens (so their first sync can add their
      // accounts), or just `userId` when the body names one.
      let users: Set<string>
      if (typeof body?.userId === "string") {
        users = new Set([body.userId])
      } else {
        const [owners, savers] = await Promise.all([
          selectAll<{ user_id: string }>((from, to) =>
            db
              .from("accounts")
              .select("user_id")
              .not("akahu_id", "is", null)
              .eq("archived", false)
              .order("id")
              .range(from, to)
          ),
          selectAll<{ user_id: string }>((from, to) =>
            db
              .from("settings")
              .select("user_id")
              .eq("key", USER_TOKEN_SETTING)
              .order("user_id")
              .range(from, to)
          ),
        ])
        users = new Set([...owners, ...savers].map((o) => o.user_id))
      }
      const results = []
      for (const userId of users) {
        try {
          results.push({ userId, ...(await syncUser(userId, "schedule")) })
        } catch (err) {
          console.error(userId, err)
          results.push({ userId, error: message(err) })
        }
      }
      return json({ results })
    }

    const { data, error } = await db.auth.getUser(token)
    if (error || !data.user) return json({ error: "You're signed out. Sign in again." }, 401)
    const accountId = Number.isInteger(body?.accountId) ? (body.accountId as number) : undefined
    return json(await syncUser(data.user.id, "app", accountId))
  } catch (err) {
    console.error(err)
    return json({ error: message(err) }, 500)
  }
})
