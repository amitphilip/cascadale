import "server-only"

import { cache } from "react"
import { cookies, headers } from "next/headers"
import { createServerClient } from "@supabase/ssr"
import { createClient, type PostgrestError } from "@supabase/supabase-js"

import * as schema from "./schema"

export function supabaseEnv() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.local (see .env.example)")
  }
  return { url, key }
}

/** The access token in a request's `Authorization: Bearer` header, if any. */
export function bearerToken(authorization: string | null) {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

/** A client that acts as whoever holds this access token (e.g. one issued to an MCP client). */
export function tokenClient(token: string) {
  const { url, key } = supabaseEnv()
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

/**
 * A client acting as the signed-in user, one per request: from the bearer token when the
 * request carries one (the MCP endpoint), otherwise from the session cookies.
 * Row level security scopes every query to that user.
 */
export const getDb = cache(async () => {
  const token = bearerToken((await headers()).get("authorization"))
  if (token) return tokenClient(token)
  return cookieClient(await cookies())
})

function cookieClient(store: Awaited<ReturnType<typeof cookies>>) {
  const { url, key } = supabaseEnv()
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // Server components can't set cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  })
}

export type Db = Awaited<ReturnType<typeof getDb>>

/** The signed-in user's id; throws when signed out. */
export async function getUserId(db?: Db) {
  db ??= await getDb()
  // A token client has no session to read claims from, so check its token instead.
  const token = bearerToken((await headers()).get("authorization"))
  const { data } = await db.auth.getClaims(token ?? undefined)
  const id = data?.claims.sub
  if (!id) throw new Error("You're signed out. Sign in again.")
  return id
}

/** Whose data the signed-in user works on: their household's owner, or themselves. */
export async function getOwnerId(db?: Db) {
  db ??= await getDb()
  const id = await must<string | null>(db.rpc("data_owner"))
  if (!id) throw new Error("You're signed out. Sign in again.")
  return id
}

type Result = { data: unknown; error: PostgrestError | null }

export class DbError extends Error {
  code: string
  constructor(error: PostgrestError) {
    super(error.message)
    this.code = error.code
  }
}

/** Await a query, throwing on error. Without generated types, the caller names the row shape. */
export async function must<T>(query: PromiseLike<Result>): Promise<T> {
  const { data, error } = await query
  if (error) throw new DbError(error)
  return data as T
}

// The API returns at most this many rows per request (Supabase's default max_rows).
const PAGE = 1000

/** Every row of a query that may exceed the API's row limit. The query must have a stable order. */
export async function selectAll<T>(page: (from: number, to: number) => PromiseLike<Result>) {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const rows = await must<T[]>(page(from, from + PAGE - 1))
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

/**
 * Column lists that select a table's rows in the app's camelCase shape (see schema.ts).
 * PostgREST returns numeric columns as JSON numbers and dates as ISO strings.
 */
export const COLUMNS = {
  accounts:
    "id, name, type, institution, openingBalance:opening_balance, archived, akahuId:akahu_id, akahuStart:akahu_start, createdAt:created_at",
  categories: "id, name, kind, monthlyBudget:monthly_budget",
  rules:
    "id, pattern, categoryId:category_id, kind, source, confidence, note, reason, createdAt:created_at",
  recurringOverrides:
    "key, basis, growthRate:growth_rate, amount, excluded, updatedAt:updated_at",
  categoryProjections:
    "categoryId:category_id, basis, growthRate:growth_rate, amount, updatedAt:updated_at",
  planThreads: "id, snapshot, createdAt:created_at",
  planMessages:
    "id, threadId:thread_id, role, content, context, plan, createdAt:created_at",
  upcomingExpenses:
    "id, name, amount, dueDate:due_date, accountId:account_id, note, createdAt:created_at",
  checkIns:
    "id, periodStart:period_start, periodEnd:period_end, stats, result, createdAt:created_at",
  casNotes:
    "id, kind, content, dueDate:due_date, createdAt:created_at, resolvedAt:resolved_at, resolution",
} as const

export { schema }
