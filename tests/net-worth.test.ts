import { describe, expect, test } from "vitest"

import { buildNetWorth, monthEnds, netWorthHistory } from "@/lib/net-worth"

const account = (id: number, type: string, balance: number, archived = false) => ({
  id,
  name: `Account ${id}`,
  type,
  institution: null,
  balance,
  archived,
})

describe("buildNetWorth", () => {
  test("adds valued assets to balances and subtracts what's owed", () => {
    const out = buildNetWorth(
      [account(1, "checking", 500.5), account(2, "investment", 1000), account(3, "loan", -600000)],
      [{ id: 1, name: "House", kind: "property", value: 900000 }]
    )
    expect(out.totals).toEqual({ assets: 900000, investments: 1000, cash: 500.5, debts: -600000 })
    expect(out.owned).toBe(901500.5)
    expect(out.netWorth).toBe(301500.5)
  })

  test("an overdrawn cheque account is a debt", () => {
    const out = buildNetWorth([account(1, "checking", -23530.09)], [])
    expect(out.cash).toEqual([])
    expect(out.debts.map((a) => a.id)).toEqual([1])
    expect(out.netWorth).toBe(-23530.09)
  })

  test("leaves out archived and empty accounts", () => {
    const out = buildNetWorth([account(1, "savings", 100, true), account(2, "savings", 0)], [])
    expect(out.cash).toEqual([])
    expect(out.netWorth).toBe(0)
  })
})

describe("netWorthHistory", () => {
  const accounts = [
    { id: 1, openingBalance: 100, archived: false },
    { id: 2, openingBalance: -1000, archived: false },
    { id: 3, openingBalance: 5000, archived: true },
  ]
  const txs = [
    { accountId: 1, date: "2026-09-15", amount: 50 },
    { accountId: 2, date: "2026-10-15", amount: 200 },
    { accountId: 3, date: "2026-10-15", amount: 999 },
  ]

  test("balances on each date, with assets at today's value", () => {
    expect(netWorthHistory(accounts, txs, 500, ["2026-08-31", "2026-09-30", "2026-10-30"])).toEqual([
      { date: "2026-08-31", netWorth: -400, debts: -1000 },
      { date: "2026-09-30", netWorth: -350, debts: -1000 },
      { date: "2026-10-30", netWorth: -150, debts: -800 },
    ])
  })
})

describe("monthEnds", () => {
  test("month ends before the last date, then the last date", () => {
    expect(monthEnds("2026-10-30", 3)).toEqual(["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-30"])
  })

  test("crosses the year", () => {
    expect(monthEnds("2026-01-10", 2)).toEqual(["2025-11-30", "2025-12-31", "2026-01-10"])
  })
})
