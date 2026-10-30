import { describe, expect, test } from "vitest"

import { balanceChanges, sinceCheckIn, withoutLoanAccounts } from "@/lib/checkin-window"

describe("sinceCheckIn", () => {
  test("leaves out history that was only added since the last check-in", () => {
    const rows = [{ date: "2024-11-02" }, { date: "2026-10-02" }, { date: "2026-10-28" }]
    expect(sinceCheckIn(rows, "2026-10-02")).toEqual([{ date: "2026-10-02" }, { date: "2026-10-28" }])
  })
})

describe("withoutLoanAccounts", () => {
  test("a loan's principal lines aren't income", () => {
    const rows = [
      { accountId: 1, description: "Salary" },
      { accountId: 2, description: "Principal payment" },
    ]
    const accounts = [
      { id: 1, type: "checking" },
      { id: 2, type: "loan" },
    ]
    expect(withoutLoanAccounts(rows, accounts).map((r) => r.description)).toEqual(["Salary"])
  })
})

describe("balanceChanges", () => {
  test("deposits count, so paying into an account isn't shown as it falling", () => {
    const joint = 34
    const changes = balanceChanges([
      { accountId: joint, amount: -1817.44 },
      { accountId: joint, amount: -1817.44 },
      { accountId: joint, amount: 2000 },
      { accountId: joint, amount: "1577.33" },
    ])
    expect(changes.get(joint)).toBe(-57.55)
  })
})
