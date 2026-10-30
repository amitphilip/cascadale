import { describe, expect, test } from "vitest"

import { buildNetWorth } from "@/lib/net-worth"

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
