import "server-only"

import { FunctionsHttpError } from "@supabase/supabase-js"

import { getDb, must, selectAll, type Db } from "@/lib/db"
import {
  AKAHU_IGNORED_SETTING,
  akahuApi,
  localDate,
  type AkahuAccount,
} from "@/supabase/functions/_shared/akahu"

// Akahu bank feeds. The app keeps the tokens, lists your Akahu accounts and links them;
// the akahu-sync edge function (supabase/functions) pulls in their transactions.

export const AKAHU_APP_TOKEN_SETTING = "akahuAppToken"
export const AKAHU_USER_TOKEN_SETTING = "akahuUserToken"

export type { AkahuAccount }
export { AKAHU_IGNORED_SETTING, accountType } from "@/supabase/functions/_shared/akahu"

async function savedTokens(db: Db) {
  const rows = await must<{ key: string; value: string }[]>(
    db
      .from("settings")
      .select("key, value")
      .in("key", [AKAHU_APP_TOKEN_SETTING, AKAHU_USER_TOKEN_SETTING])
  )
  const get = (key: string) => rows.find((r) => r.key === key)?.value
  const appToken = get(AKAHU_APP_TOKEN_SETTING)
  const userToken = get(AKAHU_USER_TOKEN_SETTING)
  return appToken && userToken ? { appToken, userToken } : null
}

/** The tokens saved in Settings, else AKAHU_APP_TOKEN and AKAHU_USER_TOKEN from the environment. */
async function getTokens(db: Db) {
  const saved = await savedTokens(db)
  if (saved) return { ...saved, source: "settings" as const }
  const appToken = process.env.AKAHU_APP_TOKEN
  const userToken = process.env.AKAHU_USER_TOKEN
  return appToken && userToken ? { appToken, userToken, source: "env" as const } : null
}

/** Akahu accounts you chose not to sync (so the sync doesn't add an account for them). */
async function ignoredIds(db: Db) {
  const [row] = await must<{ value: string }[]>(
    db.from("settings").select("value").eq("key", AKAHU_IGNORED_SETTING)
  )
  return new Set<string>(row ? JSON.parse(row.value) : [])
}

export async function setAkahuIgnored(db: Db, akahuId: string, ignored: boolean) {
  const ids = await ignoredIds(db)
  if (ids.has(akahuId) === ignored) return
  if (ignored) ids.add(akahuId)
  else ids.delete(akahuId)
  await must(
    db.from("settings").upsert({ key: AKAHU_IGNORED_SETTING, value: JSON.stringify([...ids]) })
  )
}

/** What Settings shows about the tokens, without ever sending them to the browser. */
export async function getAkahuStatus() {
  const tokens = await getTokens(await getDb())
  return tokens ? { source: tokens.source, hint: tokens.userToken.slice(-4) } : null
}

export type AkahuStatus = Awaited<ReturnType<typeof getAkahuStatus>>

export async function akahuClient(db: Db) {
  const tokens = await getTokens(db)
  if (!tokens) throw new Error("Add your Akahu tokens in Settings to sync bank feeds")
  return akahuApi(tokens)
}

export type LinkedAccount = {
  id: number
  akahuId: string
  akahuStart: string | null
}

/**
 * Run the akahu-sync edge function as the signed-in user: every linked account, or only
 * `accountId`. Returns how many transactions it added, how many rules categorized, and
 * which accounts failed.
 */
export async function runAkahuSync(db: Db, accountId?: number) {
  const { data, error } = await db.functions.invoke<{
    inserted: number
    categorized: number
    /** accounts whose sync failed; the others still synced */
    failed: { accountId: number; error: string }[]
    /** accounts created for, or matched by name to, Akahu accounts that had none */
    created: number
    matched: number
  }>(
    "akahu-sync",
    { body: accountId === undefined ? {} : { accountId } }
  )
  if (error) {
    const detail =
      error instanceof FunctionsHttpError
        ? ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error
        : null
    throw new Error(detail ?? "Couldn't reach the akahu-sync edge function. Is it deployed?")
  }
  return data!
}

/** Linked, unarchived accounts. */
export function linkedAccounts(db: Db) {
  return selectAll<LinkedAccount>((from, to) =>
    db
      .from("accounts")
      .select("id, akahuId:akahu_id, akahuStart:akahu_start")
      .not("akahu_id", "is", null)
      .eq("archived", false)
      .order("id")
      .range(from, to)
  )
}

export type AkahuOverview =
  | { connected: false }
  | {
      connected: true
      error: string | null
      accounts: {
        akahuId: string
        name: string
        institution: string
        formattedAccount: string | null
        balance: number | null
        active: boolean
        /** when Akahu last fetched from the bank */
        refreshedAt: string | null
        /** the account of yours it syncs into */
        linkedTo: number | null
        /** you chose not to sync it; otherwise an unlinked one gets an account on the next sync */
        ignored: boolean
        /** the latest sync into it (akahu_syncs) */
        lastSync: { at: string; inserted: number | null; error: string | null } | null
      }[]
    }

/** Your Akahu accounts and which of your accounts each one syncs into, for the Import page. */
export async function getAkahuOverview(): Promise<AkahuOverview> {
  const db = await getDb()
  if (!(await getTokens(db))) return { connected: false }
  const [linked, ignored] = await Promise.all([linkedAccounts(db), ignoredIds(db)])
  // Newest first, so the first row per account is its latest run.
  const syncs = await must<
    { accountId: number; akahuId: string; at: string; inserted: number | null; error: string | null }[]
  >(
    db
      .from("akahu_syncs")
      .select("accountId:account_id, akahuId:akahu_account_id, at:finished_at, inserted, error")
      .in("account_id", linked.map((l) => l.id))
      .not("finished_at", "is", null)
      .order("id", { ascending: false })
      .limit(linked.length * 50)
  )
  let items: AkahuAccount[]
  try {
    items = await (await akahuClient(db)).accounts()
  } catch (err) {
    return {
      connected: true,
      error: err instanceof Error ? err.message : "Couldn't reach Akahu",
      accounts: [],
    }
  }
  function linkOf(a: AkahuAccount) {
    const account = linked.find(
      (l) => l.akahuId === a._id || (a._migrated && l.akahuId === a._migrated)
    )
    if (!account) return { linkedTo: null, lastSync: null }
    const sync = syncs.find((s) => s.accountId === account.id && s.akahuId === account.akahuId)
    return {
      linkedTo: account.id,
      lastSync: sync ? { at: sync.at, inserted: sync.inserted, error: sync.error } : null,
    }
  }

  return {
    connected: true,
    error: null,
    accounts: items
      .filter((a) => a.attributes.includes("TRANSACTIONS"))
      .map((a) => ({
        akahuId: a._id,
        name: a.name,
        institution: a.connection.name,
        formattedAccount: a.formatted_account ?? null,
        balance: a.balance?.current ?? null,
        active: a.status === "ACTIVE",
        refreshedAt: a.refreshed?.transactions ?? null,
        ignored: ignored.has(a._id) || (!!a._migrated && ignored.has(a._migrated)),
        ...linkOf(a),
      })),
  }
}

/**
 * Pending transactions on your linked accounts, mapped to the account of yours each syncs
 * into. Akahu doesn't store them, so they're read live; an account that fails is skipped.
 */
export async function getAkahuPending() {
  const db = await getDb()
  if (!(await getTokens(db))) return []
  const [linked, akahu] = await Promise.all([linkedAccounts(db), akahuClient(db)])
  const lists = await Promise.all(
    linked.map(async (l) => {
      try {
        return (await akahu.pending(l.akahuId)).map((t) => ({
          accountId: l.id,
          date: localDate(t.date),
          description: t.description.trim(),
          amount: Math.round(t.amount * 100) / 100,
        }))
      } catch (err) {
        console.error(l.id, err)
        return []
      }
    })
  )
  return lists.flat()
}
