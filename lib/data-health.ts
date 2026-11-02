import "server-only"

import { getAkahuOverview, getAkahuPending, type AkahuOverview } from "@/lib/akahu"
import { getDb, must } from "@/lib/db"
import { buildDataHealth, type PostedTx } from "@/lib/health"
import { loadPlanData } from "@/lib/planner"
import { getAccountsWithBalances } from "@/lib/queries"
import { findSeriesBreaks } from "@/lib/recurring"
import { daysBefore, todayLocal } from "@/supabase/functions/_shared/akahu"

/** Days of posted transactions read back to settle pending ones. */
const POSTED_DAYS = 10

/**
 * Data health as the signed-in user sees it: bank feed freshness and drift per account,
 * pending transactions not yet posted, and recurring series that may have been replaced. Pass the Akahu overview when the
 * caller already has it, to save a round trip.
 */
export async function loadDataHealth(overview?: AkahuOverview) {
  const since = daysBefore(todayLocal(), POSTED_DAYS).slice(0, 10)
  const [accounts, feed, pending, posted, data] = await Promise.all([
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
    loadPlanData(),
  ])
  return buildDataHealth({
    now: new Date(),
    accounts,
    feed,
    pending,
    posted: posted.map((t) => ({ ...t, amount: Number(t.amount) })),
    seriesBreaks: data ? findSeriesBreaks(data.txs, data.series, data.snapshot.dataEnd) : [],
  })
}
