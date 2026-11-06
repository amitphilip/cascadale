import { describe, expect, test } from "vitest"

import { findAccount, resolveAccountId } from "@/lib/account-lookup"

import { ACCOUNTS } from "./fixtures/october-2026"
import { harness } from "./harness"

const accounts = [
  { id: 1, name: "Everyday", aliases: [], purpose: "Day-to-day spending" },
  { id: 2, name: "Joint", aliases: ["bills account"], purpose: "Household bills" },
  { id: 7, name: "Short Term Invest", aliases: ["rates", "rates account"], purpose: "Council rates" },
  { id: 8, name: "Tax Savings", aliases: [], purpose: "Provisional tax" },
  { id: 9, name: "GST", aliases: [], purpose: "GST and tax for the business" },
  { id: 10, name: "Old Tax", aliases: [], purpose: null, archived: true },
]

describe("finding an account by what people call it", () => {
  test("'rates account' resolves to Short Term Invest", () => {
    expect(findAccount(accounts, "rates account").match?.name).toBe("Short Term Invest")
    expect(findAccount(accounts, "the rates account").match?.name).toBe("Short Term Invest")
    expect(findAccount(accounts, "Rates").match?.id).toBe(7)
    expect(findAccount(accounts, "council rates").match?.id).toBe(7)
    expect(findAccount(accounts, "day-to-day spending").match).toMatchObject({ id: 1, matchedOn: "purpose" })
  })

  test("names and aliases beat purposes", () => {
    expect(findAccount(accounts, "joint").match?.id).toBe(2)
    expect(findAccount(accounts, "bills account").match?.id).toBe(2)
  })

  test("an unclear phrase returns the candidates, and archived accounts are left out", () => {
    const { match, candidates } = findAccount(accounts, "tax")
    expect(match).toBeNull()
    expect(candidates.map((c) => c.id).sort()).toEqual([8, 9])
    expect(() => resolveAccountId(accounts, "tax")).toThrow(/could be several accounts.*8 Tax Savings/)
    expect(() => resolveAccountId(accounts, "boat")).toThrow(/no account matches "boat"/)
  })
})

describe("plan tools take accounts in words", () => {
  test("upsert_pot with toAccount 'savings pot' resolves through aliases", async () => {
    const h = harness()
    h.deps.accounts = async () =>
      Object.values(ACCOUNTS).map((a) => ({ ...a, aliases: a.id === ACCOUNTS.streamline.id ? ["rates account"] : [] }))
    await h.call("upsert_pot", {
      operationId: "op-1",
      name: "Rates",
      amount: 120,
      frequency: "monthly",
      fromAccount: "Joint",
      toAccount: "the rates account",
    })
    expect(h.pots[0]).toMatchObject({ fromAccountId: ACCOUNTS.joint.id, toAccountId: ACCOUNTS.streamline.id })
  })
})
