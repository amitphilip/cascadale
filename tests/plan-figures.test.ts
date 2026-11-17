import { describe, expect, test } from "vitest"

import { planOneOff } from "@/lib/one-offs"
import { oneOffFigure, planFigures, type CategoryFigure } from "@/lib/plan-figures"

const TODAY = "2026-11-18"

const cat = (c: Partial<CategoryFigure> & { name: string; projected: number }): CategoryFigure => ({
  categoryId: 1,
  budget: null,
  budgetPeriod: null,
  budgetPercent: null,
  recurring: 0,
  ...c,
})

describe("oneOffFigure", () => {
  test("spreads what's still to put in over the months to the last contribution", () => {
    const o = {
      id: 7,
      name: "Holiday",
      accountId: 2,
      total: 6000,
      startDate: "2026-11-01",
      finishDate: "2027-05-01",
      outMode: "single" as const,
      outEvery: null,
      inEvery: "month" as const,
      setAside: 0,
    }
    const plan = planOneOff(o, [], TODAY)
    const f = oneOffFigure(o, plan, TODAY)
    expect(f.toPutIn).toBe(6000)
    // contributions on the 1st of Dec … May: about five and a half months away
    expect(f.monthly).toBeGreaterThan(1000)
    expect(f.monthly).toBeLessThan(1200)
    expect(f.needNow).toBe(0)
  })

  test("a one-off with nothing left to put in needs nothing a month", () => {
    const o = {
      id: 8,
      name: "Rego",
      accountId: 2,
      total: 300,
      startDate: "2026-11-01",
      finishDate: "2026-12-15",
      outMode: "single" as const,
      outEvery: null,
      inEvery: "month" as const,
      setAside: 300,
    }
    const f = oneOffFigure(o, planOneOff(o, [], TODAY), TODAY)
    expect(f.toPutIn).toBe(0)
    expect(f.monthly).toBe(0)
  })
})

describe("planFigures", () => {
  test("plans with budgets where set, projections elsewhere, and flags tight budgets", () => {
    const f = planFigures(
      6000,
      [
        cat({ categoryId: 1, name: "Groceries", projected: 1200, budget: 800 }),
        cat({ categoryId: 2, name: "Power", projected: 250, budget: 240 }),
        cat({ categoryId: 3, name: "Fuel", projected: 300 }),
      ],
      [
        {
          oneOffId: 1,
          name: "Holiday",
          accountId: 2,
          total: 6000,
          finishDate: "2027-05-01",
          held: 0,
          remaining: 6000,
          toPutIn: 6000,
          status: "on_track",
          monthly: 1000,
          needNow: 0,
        },
      ]
    )
    expect(f.committed).toBe(800 + 240 + 300)
    expect(f.projectedSpend).toBe(1750)
    expect(f.oneOffs).toBe(1000)
    expect(f.leftOver).toBe(6000 - 1340 - 1000)
    expect(f.leftOverAsProjected).toBe(6000 - 1750 - 1000)
    // groceries' budget is a third under how it runs; power's is within 15%
    expect(f.tightBudgets.map((t) => t.name)).toEqual(["Groceries"])
  })
})
