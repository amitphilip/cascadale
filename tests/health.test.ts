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
  test("reports drift from the bank, pending transactions and a plan built on moved balances", () => {
    const health = buildDataHealth(healthInput())
    expect(health.status).toBe("attention")
    expect(health.drift).toEqual([
      { account: "Everyday", cascadale: 1082.5, bank: 1232.5, difference: -150, explainedByPending: false },
    ])
    const joint = health.accounts.find((a) => a.accountId === ACCOUNTS.joint.id)!
    expect(joint.pending).toEqual({ count: 1, total: -45 })
    expect(joint.balanceWithPending).toBe(22900)
    expect(health.pendingTransactions[0]).toMatchObject({ account: "Joint", pending: true, amount: -45 })
    expect(health.plan?.movedMaterially).toBe(true)
    expect(health.plan?.basis.find((b) => b.name === "Joint")).toMatchObject({
      planBalance: 18825,
      actualBalance: 22945,
      moved: 4120,
      material: true,
    })
    expect(health.staleAccounts).toEqual([])
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
