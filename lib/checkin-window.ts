/** Which transactions a check-in covers, and what they did to each balance. Pure. */

/**
 * Of the rows logged since the last check-in, the ones dated from its last day on. History
 * added late, such as a newly connected account's backfill, is new to the app but isn't
 * something that just happened.
 */
export function sinceCheckIn<T extends { date: string }>(rows: T[], periodEnd: string) {
  return rows.filter((r) => r.date >= periodEnd)
}

/** Net movement per account. Pass every row, transfers included. */
export function balanceChanges(rows: { accountId: number; amount: number | string }[]) {
  const out = new Map<number, number>()
  for (const r of rows)
    out.set(r.accountId, Math.round(((out.get(r.accountId) ?? 0) + Number(r.amount)) * 100) / 100)
  return out
}
