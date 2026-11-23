// Cas's proactive messages, run after each user's sync (see ../_shared/nudges.ts for what
// they say). Each is saved once per event in cas_nudges (dedupe_key), shown in Home's inbox,
// and pushed to every device in the household that turned Cas's messages on.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0"

import { todayLocal } from "../_shared/akahu.ts"
import {
  PAY_MIN,
  payCadence,
  paydayNudge,
  weeklyNudge,
  type BudgetLine,
  type Every,
  type Nudge,
} from "../_shared/nudges.ts"
import { sendPush, type VapidKeys } from "../_shared/web-push.ts"

/** Pays dated this many days back still get a nudge (a pay can post a day or two late). */
const PAY_DAYS = 3
/** The Monday check-in goes out with the first sync from this hour, New Zealand time. */
const WEEKLY_HOUR = 7

type Db = SupabaseClient

async function must<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data as T
}

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

function nzHourAndWeekday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now)
  return { hour: Number(parts.find((p) => p.type === "hour")?.value), weekday: parts.find((p) => p.type === "weekday")?.value }
}

function vapidKeys(): VapidKeys | null {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")
  if (!publicKey || !privateKey) return null
  return { publicKey, privateKey, subject: Deno.env.get("VAPID_SUBJECT") ?? "https://cascadale.app" }
}

async function moneyFormat(db: Db, userId: string) {
  const rows = await must<{ key: string; value: string }[]>(
    db.from("settings").select("key, value").eq("user_id", userId).in("key", ["currency", "locale"])
  )
  const get = (k: string) => rows.find((r) => r.key === k)?.value
  const locale = get("locale") ?? "en-NZ"
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency: get("currency") ?? "NZD", maximumFractionDigits: 0 })
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
  return { money: (n: number) => fmt.format(n), day: (iso: string) => day.format(new Date(`${iso}T00:00:00Z`)) }
}

/** Pays that landed in the last few days, each with the nudge for it. */
async function paydayNudges(db: Db, userId: string, money: (n: number) => string): Promise<Nudge[]> {
  const today = todayLocal()
  const incomeIds = (
    await must<{ id: number }[]>(db.from("categories").select("id").eq("user_id", userId).eq("kind", "income"))
  ).map((c) => c.id)
  if (!incomeIds.length) return []
  const pays = await must<{ id: number; date: string; amount: number; description: string; account_id: number }[]>(
    db
      .from("transactions")
      .select("id, date, amount, description, account_id")
      .eq("user_id", userId)
      .in("category_id", incomeIds)
      .gte("amount", PAY_MIN)
      .gte("date", addDays(today, -PAY_DAYS))
  )
  if (!pays.length) return []

  const [history, accounts, plan] = await Promise.all([
    must<{ date: string; amount: number; account_id: number }[]>(
      db
        .from("transactions")
        .select("date, amount, account_id")
        .eq("user_id", userId)
        .in("category_id", incomeIds)
        .gte("amount", PAY_MIN)
        .gte("date", addDays(today, -75))
    ),
    must<{ id: number; name: string }[]>(db.from("accounts").select("id, name").eq("user_id", userId)),
    must<{ id: number }[]>(db.from("plans").select("id").eq("user_id", userId).order("id", { ascending: false }).limit(1)),
  ])
  const name = new Map(accounts.map((a) => [a.id, a.name]))
  const items = plan[0]
    ? await must<{ title: string; amount: number | null; every: Every | null; account_id: number | null; from_account_id: number | null }[]>(
        db
          .from("plan_items")
          .select("title, amount, every, account_id, from_account_id")
          .eq("plan_id", plan[0].id)
          .eq("kind", "allocation")
      )
    : []
  const moves = items
    .filter(
      (i) =>
        i.amount !== null &&
        Number(i.amount) > 0 &&
        i.every !== null &&
        // money that stays where it is isn't a move
        i.account_id !== i.from_account_id
    )
    .map((i) => ({
      title: i.title,
      amount: Number(i.amount),
      every: i.every!,
      toAccount: i.account_id === null ? null : (name.get(i.account_id) ?? null),
      fromAccountId: i.from_account_id,
    }))

  return pays.map((p) =>
    paydayNudge({
      pay: { id: p.id, date: p.date, amount: Number(p.amount), description: p.description, accountId: p.account_id },
      accountName: name.get(p.account_id) ?? "your account",
      cadence: payCadence(
        p.date,
        Number(p.amount),
        history.filter((h) => h.account_id === p.account_id).map((h) => ({ date: h.date, amount: Number(h.amount) }))
      ),
      moves,
      money,
    })
  )
}

/** Monday's check-in, from the first sync after WEEKLY_HOUR in New Zealand. */
async function weeklyCheckIn(db: Db, userId: string, fmt: Awaited<ReturnType<typeof moneyFormat>>): Promise<Nudge | null> {
  const { hour, weekday } = nzHourAndWeekday()
  if (weekday !== "Mon" || hour < WEEKLY_HOUR) return null
  const today = todayLocal()
  const monthStart = `${today.slice(0, 7)}-01`
  const lastWeek = addDays(today, -7)
  const [y, m] = today.split("-").map(Number)
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  const monthDays = Math.round((Date.parse(nextMonth) - Date.parse(monthStart)) / 86_400_000)
  // on the 1st, look back at the month just gone
  const from = today === monthStart ? addDays(monthStart, -1).slice(0, 8) + "01" : monthStart
  const monthGone = today === monthStart ? 1 : (Number(today.slice(8)) - 1) / monthDays

  const [monthSpend, weekSpend, categories, oneOffs, todos] = await Promise.all([
    must<{ id: number | null; name: string; budget: number | null; spent: number }[]>(
      db.rpc("category_spend_of", { p_user: userId, p_start: from, p_end: today })
    ),
    must<{ id: number | null; name: string; budget: number | null; spent: number }[]>(
      db.rpc("category_spend_of", { p_user: userId, p_start: lastWeek, p_end: today })
    ),
    must<{ id: number; name: string; monthly_budget: number | null; weekly_budget: number | null }[]>(
      db.from("categories").select("id, name, monthly_budget, weekly_budget").eq("user_id", userId).eq("kind", "expense")
    ),
    must<{ name: string; total: number; finish_date: string }[]>(
      db
        .from("one_offs")
        .select("name, total, finish_date")
        .eq("user_id", userId)
        .gte("finish_date", today)
        .lte("finish_date", addDays(today, 14))
        .order("finish_date")
    ),
    must<{ id: number }[]>(
      db
        .from("cas_notes")
        .select("id")
        .eq("user_id", userId)
        .eq("kind", "todo")
        .is("resolved_at", null)
        .is("ref", null)
        .lte("due_date", addDays(today, 6))
    ),
  ])
  const spent = (rows: typeof monthSpend, id: number) => Math.max(0, Number(rows.find((r) => r.id === id)?.spent ?? 0))
  const budgets = categories.flatMap((c): BudgetLine[] =>
    c.weekly_budget !== null && Number(c.weekly_budget) > 0
      ? [{ name: c.name, budget: Number(c.weekly_budget), spent: spent(weekSpend, c.id), period: "week" }]
      : c.monthly_budget !== null && Number(c.monthly_budget) > 0
        ? [{ name: c.name, budget: Number(c.monthly_budget), spent: spent(monthSpend, c.id), period: "month" }]
        : []
  )
  const budgetedIds = new Set(
    categories
      .filter((c) => Number(c.weekly_budget ?? 0) > 0 || Number(c.monthly_budget ?? 0) > 0)
      .map((c) => c.id)
  )
  const unbudgeted = monthSpend
    .filter((r) => r.id !== null && !budgetedIds.has(r.id) && categories.some((c) => c.id === r.id))
    .map((r) => ({ name: r.name, spent: Number(r.spent) }))

  return weeklyNudge({
    monday: today,
    monthGone,
    budgets,
    unbudgeted,
    dueSoon: oneOffs.map((o) => ({ name: o.name.split(" - ")[0], total: Number(o.total), date: o.finish_date })),
    todosDue: todos.length,
    money: fmt.money,
    day: fmt.day,
  })
}

/**
 * Work out this sync's nudges, save the new ones and push them. Best effort: returns how
 * many were new, and never fails the sync.
 */
export async function runNudges(db: Db, userId: string) {
  const fmt = await moneyFormat(db, userId)
  const nudges = [...(await paydayNudges(db, userId, fmt.money)), ...[await weeklyCheckIn(db, userId, fmt)].filter((n): n is Nudge => n !== null)]
  if (!nudges.length) return 0

  // insert only the ones not raised before
  const saved = await must<{ id: number; dedupe_key: string }[]>(
    db
      .from("cas_nudges")
      .upsert(
        nudges.map((n) => ({ user_id: userId, kind: n.kind, title: n.title, body: n.body, dedupe_key: n.dedupeKey, due_date: n.dueDate })),
        { onConflict: "user_id,dedupe_key", ignoreDuplicates: true }
      )
      .select("id, dedupe_key")
  )
  if (!saved.length) return 0

  const vapid = vapidKeys()
  if (vapid) {
    const subs = await must<{ id: number; endpoint: string; p256dh: string; auth: string }[]>(
      db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId)
    )
    for (const s of saved) {
      const n = nudges.find((x) => x.dedupeKey === s.dedupe_key)!
      for (const sub of subs) {
        try {
          const status = await sendPush(sub, { title: n.title, body: n.push, url: "/overview", tag: n.dedupeKey }, vapid)
          if (status === 404 || status === 410) await must(db.from("push_subscriptions").delete().eq("id", sub.id))
          else if (status >= 300) console.error("push", sub.id, status)
        } catch (err) {
          console.error("push", sub.id, err)
        }
      }
      await must(db.from("cas_nudges").update({ pushed_at: new Date().toISOString() }).eq("id", s.id))
    }
  }
  return saved.length
}
