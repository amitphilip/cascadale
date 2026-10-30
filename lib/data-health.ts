import "server-only"

import { getAkahuOverview, getAkahuPending, type AkahuOverview } from "@/lib/akahu"
import { getDb, must } from "@/lib/db"
import { buildDataHealth, type PostedTx } from "@/lib/health"
import { loadPlanData } from "@/lib/planner"
import { getAccountsWithBalances, getPlanThread } from "@/lib/queries"
import { findSeriesBreaks } from "@/lib/recurring"
import { daysBefore, todayLocal } from "@/supabase/functions/_shared/akahu"

/** Days of posted transactions read back to settle pending ones. */
const POSTED_DAYS = 10

/**
 * Data health as the signed-in user sees it: bank feed freshness and drift per account,
 * pending transactions not yet posted, the current plan's basis against today's balances,
 * and recurring series that may have been replaced. Pass the Akahu overview when the
 * caller already has it, to save a round trip.
 */
export async function loadDataHealth(overview?: AkahuOverview) {
  const since = daysBefore(todayLocal(), POSTED_DAYS).slice(0, 10)
  const [accounts, feed, pending, posted, thread, data] = await Promise.all([
    getAccountsWithBalances(),
    overview ?? getAkahuOverview().catch((err: Error): AkahuOverview => ({ connected: true, error: err.message, accounts: [] })),
    getAkahuPending().catch(() => []),
    getDb().then((db) =>
      must<PostedTx[]>(
        db
          .from("transactions")
          .select("accountId:account_id, date, description, amount")
          .gte("date", since)
          .order("id")
      )
    ),
    getPlanThread(),
    loadPlanData(),
  ])
  const message = thread?.messages.findLast((m) => m.plan)
  return buildDataHealth({
    now: new Date(),
    accounts,
    feed,
    pending,
    posted: posted.map((t) => ({ ...t, amount: Number(t.amount) })),
    plan:
      thread && message
        ? { createdAt: message.createdAt, dataEnd: thread.snapshot.dataEnd, accounts: thread.snapshot.accounts }
        : null,
    seriesBreaks: data ? findSeriesBreaks(data.txs, data.series, data.snapshot.dataEnd) : [],
  })
}
