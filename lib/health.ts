import type { SeriesBreak } from "@/lib/recurring"

/**
 * Data health: whether the numbers an answer is built from are current and agree with
 * the bank. Every MCP read that answers about money returns it as data_health, so an
 * answer is never silently built on stale feeds, drifted balances or a plan made on
 * balances that have since moved. Pure functions; lib/data-health.ts loads the inputs.
 */

/** A linked account that hasn't synced in this long is stale (the sync runs hourly). */
export const STALE_SYNC_HOURS = 26
/** Akahu refreshes from the bank about once a day; older than this is stale. */
export const STALE_REFRESH_HOURS = 36
/** Differences under this are rounding, not drift. */
const DRIFT_TOLERANCE = 1
/** A pending transaction posts within this many days, at the same amount. */
export const PENDING_MATCH_DAYS = 4

export type PendingTx = { accountId: number; date: string; description: string; amount: number }
export type PostedTx = { accountId: number; date: string; description: string; amount: number }

export type FeedAccount = {
  name: string
  linkedTo: number | null
  /** the bank's balance as Akahu reports it */
  balance: number | null
  active: boolean
  refreshedAt: string | null
  lastSync: { at: string; error: string | null } | null
}

export type HealthInput = {
  now: Date
  accounts: { id: number; name: string; type: string; balance: number; archived: boolean }[]
  feed:
    | { connected: false }
    | { connected: true; error: string | null; accounts: FeedAccount[] }
  pending: PendingTx[]
  /** recently posted transactions, to drop pending ones that have since posted */
  posted: PostedTx[]
  plan: { createdAt: string; dataEnd: string; accounts: { id: number; name: string; balance: number }[] } | null
  seriesBreaks: SeriesBreak[]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const cents = (n: number) => Math.round(n * 100)
const hoursBetween = (from: string, now: Date) =>
  Math.round(((now.getTime() - Date.parse(from)) / 3_600_000) * 10) / 10
const dayGap = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000

/**
 * Pending transactions that haven't posted yet. Each posted transaction on the same
 * account, at the same amount, from the pending day to a few days later accounts for one
 * pending one, so a payment is never counted both pending and posted.
 */
export function reconcilePending(pending: PendingTx[], posted: PostedTx[]) {
  const used = new Set<number>()
  const open: PendingTx[] = []
  const settled: { pending: PendingTx; posted: PostedTx }[] = []
  for (const p of pending.toSorted((a, b) => a.date.localeCompare(b.date))) {
    const i = posted.findIndex(
      (t, j) =>
        !used.has(j) &&
        t.accountId === p.accountId &&
        cents(t.amount) === cents(p.amount) &&
        dayGap(p.date, t.date) >= -1 &&
        dayGap(p.date, t.date) <= PENDING_MATCH_DAYS
    )
    if (i < 0) open.push(p)
    else {
      used.add(i)
      settled.push({ pending: p, posted: posted[i] })
    }
  }
  return { open, settled }
}

/** A plan's starting balance has moved materially when it's off by this much. */
export function isMaterialMove(basis: number, actual: number) {
  return Math.abs(actual - basis) >= Math.max(100, Math.abs(basis) * 0.05)
}

export function buildDataHealth(input: HealthInput) {
  const { now } = input
  const warnings: string[] = []
  const { open: pending } = reconcilePending(input.pending, input.posted)
  const pendingBy = Map.groupBy(pending, (p) => p.accountId)
  const feedBy = new Map(
    input.feed.connected ? input.feed.accounts.filter((a) => a.linkedTo !== null).map((a) => [a.linkedTo!, a]) : []
  )

  if (!input.feed.connected) warnings.push("Bank feeds aren't connected: balances are only as current as the last import")
  else if (input.feed.error) warnings.push(`Couldn't reach Akahu to check the bank: ${input.feed.error}`)

  const accounts = input.accounts
    .filter((a) => !a.archived)
    .map((a) => {
      const feed = feedBy.get(a.id)
      const own = pendingBy.get(a.id) ?? []
      const pendingTotal = round2(own.reduce((s, p) => s + p.amount, 0))
      const hoursSinceSync = feed?.lastSync ? hoursBetween(feed.lastSync.at, now) : null
      const hoursSinceRefresh = feed?.refreshedAt ? hoursBetween(feed.refreshedAt, now) : null
      const staleReason = !feed
        ? null
        : !feed.active
          ? "Akahu has lost access to it; reconnect at my.akahu.nz"
          : feed.lastSync?.error
            ? `the last sync failed: ${feed.lastSync.error}`
            : hoursSinceSync === null || hoursSinceSync > STALE_SYNC_HOURS
              ? `not synced for ${hoursSinceSync === null ? "ever" : `${Math.round(hoursSinceSync)} hours`}`
              : hoursSinceRefresh !== null && hoursSinceRefresh > STALE_REFRESH_HOURS
                ? `Akahu last refreshed from the bank ${Math.round(hoursSinceRefresh)} hours ago`
                : null
      const bank = feed?.balance ?? null
      const drift = bank === null ? null : round2(a.balance - bank)
      const withPending = round2(a.balance + pendingTotal)
      const driftWithPending = bank === null ? null : round2(withPending - bank)
      return {
        accountId: a.id,
        name: a.name,
        linked: Boolean(feed),
        lastSyncAt: feed?.lastSync?.at ?? null,
        hoursSinceSync,
        bankRefreshedAt: feed?.refreshedAt ?? null,
        hoursSinceBankRefresh: hoursSinceRefresh,
        stale: staleReason !== null,
        staleReason,
        balance: a.balance,
        bankBalance: bank,
        /** Cascadale's balance less the bank's: negative when Cascadale shows less */
        drift,
        pending: { count: own.length, total: pendingTotal },
        balanceWithPending: withPending,
        driftWithPending,
        driftExplainedByPending:
          drift !== null && Math.abs(drift) >= DRIFT_TOLERANCE && Math.abs(driftWithPending!) < DRIFT_TOLERANCE,
      }
    })

  const stale = accounts.filter((a) => a.stale)
  for (const a of stale) warnings.push(`${a.name} is stale: ${a.staleReason}`)
  const drifted = accounts.filter((a) => a.drift !== null && Math.abs(a.drift) >= DRIFT_TOLERANCE)
  for (const a of drifted)
    warnings.push(
      `${a.name} is ${Math.abs(a.drift!).toFixed(2)} ${a.drift! < 0 ? "below" : "above"} the bank (${a.balance.toFixed(2)} vs ${a.bankBalance!.toFixed(2)})${a.driftExplainedByPending ? ", explained by pending transactions" : ""}`
    )

  let plan = null
  if (input.plan) {
    const current = new Map(accounts.map((a) => [a.accountId, a]))
    const basis = input.plan.accounts.flatMap((p) => {
      const now = current.get(p.id)
      if (!now) return []
      return [
        {
          accountId: p.id,
          name: p.name,
          planBalance: p.balance,
          actualBalance: now.balance,
          moved: round2(now.balance - p.balance),
          material: isMaterialMove(p.balance, now.balance),
        },
      ]
    })
    const moved = basis.filter((b) => b.material)
    const ageDays = Math.floor((now.getTime() - Date.parse(input.plan.createdAt)) / 86_400_000)
    for (const b of moved)
      warnings.push(`The plan was built on ${b.name} at ${b.planBalance.toFixed(2)}; it's ${b.actualBalance.toFixed(2)} now`)
    plan = { madeAt: input.plan.createdAt, ageDays, dataEnd: input.plan.dataEnd, basis, movedMaterially: moved.length > 0 }
  }

  for (const b of input.seriesBreaks)
    warnings.push(
      `"${b.ended.example}" stopped after ${b.ended.lastDate} and "${b.candidate.example}" started at a similar amount: confirm whether it replaced it`
    )

  return {
    checkedAt: now.toISOString(),
    status: warnings.length ? ("attention" as const) : ("ok" as const),
    warnings,
    bankFeeds: !input.feed.connected ? "not_connected" : input.feed.error ? "error" : "connected",
    staleAccounts: stale.map((a) => a.name),
    drift: drifted.map((a) => ({
      account: a.name,
      cascadale: a.balance,
      bank: a.bankBalance,
      difference: a.drift,
      explainedByPending: a.driftExplainedByPending,
    })),
    accounts,
    pendingTransactions: pending.map((p) => ({
      ...p,
      account: input.accounts.find((a) => a.id === p.accountId)?.name ?? null,
      pending: true as const,
    })),
    plan,
    seriesToConfirm: input.seriesBreaks,
  }
}

export type DataHealth = ReturnType<typeof buildDataHealth>
