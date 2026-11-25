import { describe, expect, test } from "vitest"

import { buildDataHealth, reconcilePending } from "@/lib/health"

import { ACCOUNTS, healthInput } from "./fixtures/october-2026"

describe("reconcilePending", () => {
  test("a pending payment drops out once its posted version arrives", () => {
    const pending = [
      { accountId: 1, date: "2026-10-28", description: "PAK N SAVE", amount: -45 },
      { accountId: 1, date: "2026-10-28", description: "Z ENERGY", amount: -80 },
    ]
    const posted = [{ accountId: 1, date: "2026-10-29", description: "PAK N SAVE AUCKLAND", amount: -45 }]
    const { open, settled } = reconcilePending(pending, posted)
    expect(open.map((p) => p.description)).toEqual(["Z ENERGY"])
    expect(settled).toHaveLength(1)
  })
})

describe("buildDataHealth", () => {
  test("reports drift from the bank and pending transactions", () => {
    const health = buildDataHealth(healthInput())
    expect(health.status).toBe("attention")
    expect(health.drift).toEqual([
      {
        accountId: ACCOUNTS.everyday.id,
        account: "Everyday",
        institution: null,
        cascadale: 1082.5,
        bank: 1232.5,
        difference: -150,
        gap: -150,
        pendingCount: 0,
        explainedByPending: false,
        settling: false,
      },
    ])
    const joint = health.accounts.find((a) => a.accountId === ACCOUNTS.joint.id)!
    expect(joint.pending).toEqual({ count: 1, total: -45 })
    expect(joint.balanceWithPending).toBe(22900)
    expect(health.pendingTransactions[0]).toMatchObject({ account: "Joint", pending: true, amount: -45 })
    expect(health.staleAccounts).toEqual([])
  })

  test("words drift by what's left once pending is counted, and drops drift pending explains", () => {
    const health = buildDataHealth(healthInput())
    expect(health.warnings).toContain("Everyday is 150.00 below the bank (1082.50 vs 1232.50)")
    // Joint matches the bank once its pending payment is counted, or has no drift: no warning either way
    expect(health.warnings.some((w) => w.startsWith("Joint is"))).toBe(false)
  })

  test("a bank that takes pending payments out but not pending money in: drift it explains drops out", () => {
    const input = healthInput()
    if (!input.feed.connected) throw new Error("fixture is connected")
    // ANZ-style: the bank's balance already has the payment out off, not the transfer in
    input.pending = [
      { accountId: ACCOUNTS.everyday.id, date: "2026-10-28", description: "To savings", amount: -2000 },
      { accountId: ACCOUNTS.everyday.id, date: "2026-10-28", description: "Refund", amount: 30 },
    ]
    input.feed.accounts[0].balance = 1082.5 - 2000
    const health = buildDataHealth(input)
    expect(health.drift).toMatchObject([{ account: "Everyday", difference: 2000, gap: 0, explainedByPending: true }])
    expect(health.warnings.some((w) => w.startsWith("Everyday is"))).toBe(false)
  })

  test("a small gap with payments still pending is settling, not drift", () => {
    const input = healthInput()
    if (!input.feed.connected) throw new Error("fixture is connected")
    input.pending = [
      { accountId: ACCOUNTS.everyday.id, date: "2026-10-28", description: "To joint", amount: -2000 },
      { accountId: ACCOUNTS.everyday.id, date: "2026-10-28", description: "CAFE", amount: -8 },
    ]
    // the café charge settled at 32.50 at the bank, so 24.50 is left once pending is counted
    input.feed.accounts[0].balance = 1082.5 - 2000 - 32.5
    const health = buildDataHealth(input)
    expect(health.drift).toMatchObject([{ gap: 24.5, pendingCount: 2, explainedByPending: false, settling: true }])
    expect(health.warnings).toContain(
      "Everyday is 24.50 above the bank once its 2 pending transactions are counted (-925.50 vs -950.00), with 2 still pending: likely card payments settling at a different amount, so check again once they post"
    )
  })

  test("a big gap is drift even with payments pending", () => {
    const input = healthInput()
    input.pending = [{ accountId: ACCOUNTS.everyday.id, date: "2026-10-28", description: "CAFE", amount: -8 }]
    const health = buildDataHealth(input)
    expect(health.drift).toMatchObject([{ gap: -150, settling: false }])
  })

  test("flags stale accounts", () => {
    const input = healthInput()
    if (!input.feed.connected) throw new Error("fixture is connected")
    input.feed.accounts[0].lastSync = { at: "2026-10-26T08:00:00Z", error: null }
    input.feed.accounts[1].refreshedAt = "2026-10-25T03:00:00Z"
    const health = buildDataHealth(input)
    expect(health.staleAccounts).toEqual(["Everyday", "Joint"])
    expect(health.warnings.some((w) => w.startsWith("Everyday is stale: not synced for 49 hours"))).toBe(true)
  })

  test("says so when bank feeds aren't connected", () => {
    const health = buildDataHealth({ ...healthInput(), feed: { connected: false } })
    expect(health.bankFeeds).toBe("not_connected")
    expect(health.drift).toEqual([])
  })
})
