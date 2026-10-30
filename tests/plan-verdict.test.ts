import { describe, expect, test } from "vitest"

import type { Simulation } from "@/lib/plan"
import { planVerdict } from "@/lib/plan-verdict"

const sim = (over: Partial<Simulation> = {}, free = 500): Simulation =>
  ({
    potSummaries: [],
    overdrafts: [],
    uncovered: [],
    monthly: { income: 1000, bills: 0, variable: 0, setAside: 0, free },
    ...over,
  }) as unknown as Simulation

const input = {
  warnings: [],
  balanceOf: () => 100,
  accountName: (id: number) => `Account ${id}`,
  trend: null,
  money: (n: number) => `$${n}`,
  date: (iso: string) => iso,
}

describe("planVerdict", () => {
  test("all good", () => {
    const v = planVerdict({ ...input, sim: sim() })
    expect(v.tone).toBe("good")
    expect(v.headline).toBe("You’re on track")
    expect(v.bad).toEqual([])
  })

  test("spending more than comes in is bad", () => {
    const v = planVerdict({ ...input, sim: sim({}, -200) })
    expect(v.tone).toBe("bad")
    expect(v.bad).toContain("Spending $200 a month more than comes in")
  })

  test("says whether an account dips or is already overdrawn", () => {
    const overdrafts = [{ accountId: 1, date: "2026-11-01", lowest: -50 }]
    expect(planVerdict({ ...input, sim: sim({ overdrafts }) }).bad[0]).toBe(
      "Account 1 goes below zero on 2026-11-01, down to $-50"
    )
    expect(planVerdict({ ...input, balanceOf: () => -10, sim: sim({ overdrafts }) }).bad[0]).toBe(
      "Account 1 is overdrawn, down to $-50"
    )
    expect(planVerdict({ ...input, sim: sim({ overdrafts }) }).tone).toBe("watch")
  })

  test("net worth and debts over time go on the right side", () => {
    const trend = {
      months: 3,
      from: { date: "a", netWorth: 100, debts: -500 },
      to: { date: "b", netWorth: 50, debts: -400 },
    }
    const v = planVerdict({ ...input, sim: sim(), trend })
    expect(v.bad).toContain("Net worth down $50 over 3 months")
    expect(v.good).toContain("Debts down $100 over 3 months")
  })
})
