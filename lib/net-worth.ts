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
