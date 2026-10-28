// Internal transfers: money moving between the household's own accounts shows up twice,
// once out of one account and once into another. Pairing the two sides lets them be
// categorized as transfers (so neither reads as income or spending), and tells a loan
// repayment (a transfer into a loan account) from any other transfer.
//
// Shared by the Next.js app and the akahu-sync edge function, so it imports nothing.

export type TransferTx = {
  id: number
  accountId: number
  date: string
  /** signed: negative is money out */
  amount: number
  description: string
}

export type TransferAccount = { id: number; type: string }

export type TransferPair = {
  outId: number
  inId: number
  fromAccountId: number
  toAccountId: number
  /** positive */
  amount: number
  /** the day the money left */
  date: string
}

/** The two sides of a transfer post at most this many days apart. */
export const TRANSFER_WINDOW_DAYS = 3

const DAY = 86_400_000
const dayGap = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY
const cents = (n: number) => Math.round(n * 100)

/**
 * Pair money out of one account with the same amount into another within a few days.
 * Closest dates pair first, and each transaction is in at most one pair, so two equal
 * transfers a day apart pair up in order.
 */
export function pairTransfers(txs: TransferTx[], windowDays = TRANSFER_WINDOW_DAYS) {
  const inflows = new Map<number, TransferTx[]>()
  for (const t of txs) {
    if (t.amount <= 0) continue
    const k = cents(t.amount)
    inflows.set(k, [...(inflows.get(k) ?? []), t])
  }
  const edges: { out: TransferTx; in: TransferTx; gap: number }[] = []
  for (const out of txs) {
    if (out.amount >= 0) continue
    for (const inn of inflows.get(-cents(out.amount)) ?? []) {
      if (inn.accountId === out.accountId) continue
      const gap = dayGap(out.date, inn.date)
      if (gap <= windowDays) edges.push({ out, in: inn, gap })
    }
  }
  edges.sort((a, b) => a.gap - b.gap || a.out.id - b.out.id || a.in.id - b.in.id)
  const used = new Set<number>()
  const pairs: TransferPair[] = []
  for (const e of edges) {
    if (used.has(e.out.id) || used.has(e.in.id)) continue
    used.add(e.out.id)
    used.add(e.in.id)
    pairs.push({
      outId: e.out.id,
      inId: e.in.id,
      fromAccountId: e.out.accountId,
      toAccountId: e.in.accountId,
      amount: -e.out.amount,
      date: e.out.date,
    })
  }
  return pairs
}

const LOAN_WORDS = /\b(loan|mortgage|home ?loan)\b/i

/**
 * Money out of a cash account that repays a loan: paired with money into a loan account,
 * or, when the loan account isn't synced, described as a loan or mortgage payment.
 * Returns the ids of the outgoing side, which is what the household pays.
 */
export function loanRepaymentIds(
  txs: TransferTx[],
  accounts: TransferAccount[],
  pairs = pairTransfers(txs)
) {
  const type = new Map(accounts.map((a) => [a.id, a.type]))
  const isLoan = (id: number) => type.get(id) === "loan"
  const ids = new Set<number>()
  const paired = new Set<number>()
  for (const p of pairs) {
    paired.add(p.outId)
    paired.add(p.inId)
    if (isLoan(p.toAccountId) && !isLoan(p.fromAccountId)) ids.add(p.outId)
  }
  for (const t of txs) {
    if (t.amount >= 0 || paired.has(t.id) || isLoan(t.accountId)) continue
    if (LOAN_WORDS.test(t.description)) ids.add(t.id)
  }
  return ids
}
