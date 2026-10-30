/**
 * Net worth. Pure: account balances plus the assets you value by hand. An account counts
 * by its sign, so an overdrawn cheque account is money owed, whatever its type.
 */

export type NetWorthAccount = {
  id: number
  name: string
  type: string
  institution: string | null
  balance: number
  archived: boolean
}

export type NetWorthAsset = { id: number; name: string; kind: string; value: number }

const round2 = (n: number) => Math.round(n * 100) / 100
const total = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0))
const biggestFirst = (a: NetWorthAccount, b: NetWorthAccount) =>
  Math.abs(b.balance) - Math.abs(a.balance)

export function buildNetWorth<A extends NetWorthAccount, B extends NetWorthAsset>(
  accounts: A[],
  assets: B[]
) {
  const active = accounts.filter((a) => !a.archived && a.balance !== 0)
  const held = active.filter((a) => a.balance > 0)
  const investments = held.filter((a) => a.type === "investment").toSorted(biggestFirst)
  const cash = held.filter((a) => a.type !== "investment").toSorted(biggestFirst)
  const debts = active.filter((a) => a.balance < 0).toSorted(biggestFirst)

  const totals = {
    assets: total(assets.map((a) => a.value)),
    investments: total(investments.map((a) => a.balance)),
    cash: total(cash.map((a) => a.balance)),
    debts: total(debts.map((a) => a.balance)),
  }
  return {
    investments,
    cash,
    debts,
    assets: assets.toSorted((a, b) => b.value - a.value),
    totals,
    owned: round2(totals.assets + totals.investments + totals.cash),
    netWorth: round2(totals.assets + totals.investments + totals.cash + totals.debts),
  }
}

export type NetWorthPoint = { date: string; netWorth: number; debts: number }

/** The last day of each of the `months` months before `last`, oldest first, then `last`. */
export function monthEnds(last: string, months: number) {
  const [y, m] = last.split("-").map(Number)
  const ends = Array.from({ length: months }, (_, i) =>
    new Date(Date.UTC(y, m - 1 - (months - 1 - i), 0)).toISOString().slice(0, 10)
  )
  return [...ends, last]
}

/**
 * Net worth at each date, rebuilt from every account's opening balance and transactions.
 * Assets aren't dated, so their value today counts at every point.
 */
export function netWorthHistory(
  accounts: { id: number; openingBalance: number; archived: boolean }[],
  txs: { accountId: number; date: string; amount: number }[],
  assetsTotal: number,
  dates: string[]
): NetWorthPoint[] {
  const active = accounts.filter((a) => !a.archived)
  const byAccount = Map.groupBy(txs, (t) => t.accountId)
  return dates.map((date) => {
    const balances = active.map((a) =>
      (byAccount.get(a.id) ?? [])
        .filter((t) => t.date <= date)
        .reduce((s, t) => s + t.amount, a.openingBalance)
    )
    return {
      date,
      netWorth: total([...balances, assetsTotal]),
      debts: total(balances.filter((b) => b < 0)),
    }
  })
}

/** The point `monthsBack` month-ends before the latest, if the history reaches that far. */
export const pointBack = (history: NetWorthPoint[], monthsBack: number) =>
  history[history.length - 1 - monthsBack]
