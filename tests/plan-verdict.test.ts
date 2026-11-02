import { describe, expect, test } from "vitest"

import type { Simulation } from "@/lib/plan"
import {
  planStanding,
  planVerdict,
  withGoal,
  type Verdict,
} from "@/lib/plan-verdict"

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
    expect(
      planVerdict({ ...input, balanceOf: () => -10, sim: sim({ overdrafts }) })
        .bad[0]
    ).toBe("Account 1 is overdrawn, down to $-50")
    expect(planVerdict({ ...input, sim: sim({ overdrafts }) }).tone).toBe(
      "watch"
    )
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

describe("planStanding", () => {
  const good: Verdict = {
    tone: "good",
    headline: "You’re on track",
    good: [],
    bad: [],
  }
  const watch: Verdict = {
    tone: "watch",
    headline: "1 thing to look at",
    good: [],
    bad: ["x"],
  }
  const bad: Verdict = {
    tone: "bad",
    headline: "This plan doesn’t add up: 1 thing to fix",
    good: [],
    bad: ["x"],
  }

  test("no check-in: the verdict alone, marked stale", () => {
    const s = planStanding({
      verdict: watch,
      checkIn: null,
      dataEnd: "2026-11-01",
    })
    expect(s).toEqual({
      status: "watch",
      headline: "1 thing to look at",
      unchecked: null,
      stale: true,
    })
  })

  test("a fresh check-in that's worse than the verdict sets the status and headline", () => {
    const checkIn = {
      status: "off_track",
      headline: "Joint credit grew",
      periodEnd: "2026-10-25",
    } as const
    const s = planStanding({ verdict: good, checkIn, dataEnd: "2026-11-01" })
    expect(s.status).toBe("off_track")
    expect(s.headline).toBe("Joint credit grew")
    expect(s.unchecked).toBe(7)
    expect(s.stale).toBe(false)
  })

  test("a stale check-in is reported but doesn't set the status", () => {
    const checkIn = {
      status: "off_track",
      headline: "Joint credit grew",
      periodEnd: "2026-10-02",
    } as const
    const s = planStanding({ verdict: watch, checkIn, dataEnd: "2026-10-31" })
    expect(s.status).toBe("watch")
    expect(s.headline).toBe("1 thing to look at")
    expect(s.unchecked).toBe(29)
    expect(s.stale).toBe(true)
  })

  test("the verdict wins when it's worse than a fresh check-in", () => {
    const checkIn = {
      status: "watch",
      headline: "Spending a bit high",
      periodEnd: "2026-10-30",
    } as const
    const s = planStanding({ verdict: bad, checkIn, dataEnd: "2026-11-01" })
    expect(s.status).toBe("off_track")
    expect(s.headline).toBe(bad.headline)
  })

  test("both fine is on track", () => {
    const checkIn = {
      status: "on_track",
      headline: "All good",
      periodEnd: "2026-10-30",
    } as const
    expect(
      planStanding({ verdict: good, checkIn, dataEnd: "2026-11-01" }).headline
    ).toBe("You’re on track")
  })
})

describe("withGoal", () => {
  const good: Verdict = { tone: "good", headline: "You’re on track", good: [], bad: [] }
  const goal = { target: 5000, endDate: "2027-01-30" }
  const money = (n: number) => `$${n}`
  const date = (iso: string) => iso

  test("heading for the goal adds a good line and keeps the tone", () => {
    const v = withGoal(good, { ...goal, tone: "on_track", gap: 120 }, money, date)
    expect(v.tone).toBe("good")
    expect(v.good).toEqual(["Heading for the goal of $5000 by 2027-01-30"])
  })

  test("falling short sets the tone and headline when it's worse", () => {
    const v = withGoal(good, { ...goal, tone: "off_track", gap: -900 }, money, date)
    expect(v.tone).toBe("bad")
    expect(v.headline).toBe("Heading $900 short of the goal")
    expect(v.bad).toEqual(["Heading $900 short of the $5000 goal by 2027-01-30"])
  })

  test("a small shortfall doesn't hide a worse verdict", () => {
    const bad: Verdict = { tone: "bad", headline: "Fix 1 thing", good: [], bad: ["x"] }
    const v = withGoal(bad, { ...goal, tone: "watch", gap: -50 }, money, date)
    expect(v.tone).toBe("bad")
    expect(v.headline).toBe("Fix 1 thing")
    expect(v.bad).toHaveLength(2)
  })
})
