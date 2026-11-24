// What Cas does with the corrections waiting for it (the cas_queue table): a move marked
// `remember` becomes its merchant's rule, so later transactions follow it, and the latest
// such move for a merchant wins; everything else stays a one-time exception. The app's
// Update Cas (lib/cas-queue.ts) and the akahu-sync edge function's morning run
// (akahu-sync/cas-queue.ts) both plan with this and apply the result.
//
// Shared by the Next.js app and the akahu-sync edge function, so it imports nothing.

/** The Cas morning run takes in the queue with the first bank sync from this hour. */
export const CAS_QUEUE_HOUR = 6

export type QueuedMove = {
  id: number
  merchantKey: string
  toCategoryId: number | null
  toOneOffId: number | null
  remember: boolean
  createdAt: string
}

export type QueueDigest = {
  /** the merchant rules to set */
  rules: { merchantKey: string; categoryId: number }[]
  /** what Cas did with each queued move, in a line */
  outcomes: { id: number; outcome: string }[]
}

/** "countdown queen st" → "Countdown Queen St" */
export function merchantName(key: string) {
  return key.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export function digestQueue(
  items: QueuedMove[],
  names: { category: (id: number) => string; oneOff: (id: number) => string }
): QueueDigest {
  const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)

  // each merchant's latest remembered move to a category decides its rule
  const winner = new Map<string, QueuedMove>()
  for (const m of ordered) {
    if (m.remember && m.toCategoryId !== null) winner.set(m.merchantKey, m)
  }

  const outcomes = ordered.map((m) => {
    const merchant = merchantName(m.merchantKey)
    let outcome: string
    if (m.toOneOffId !== null) {
      outcome = `Counts towards ${names.oneOff(m.toOneOffId)}; ${merchant}'s other transactions are unchanged.`
    } else if (m.toCategoryId === null) {
      outcome = "Left uncategorized."
    } else if (!m.remember) {
      outcome = `Kept as a one-time move to ${names.category(m.toCategoryId)}.`
    } else if (winner.get(m.merchantKey)?.id === m.id) {
      outcome = `${merchant} now goes to ${names.category(m.toCategoryId)} by rule.`
    } else {
      const later = winner.get(m.merchantKey)!
      outcome = `Replaced by a later move: ${merchant} goes to ${names.category(later.toCategoryId!)}.`
    }
    return { id: m.id, outcome }
  })

  return {
    rules: [...winner.values()].map((m) => ({ merchantKey: m.merchantKey, categoryId: m.toCategoryId! })),
    outcomes,
  }
}
