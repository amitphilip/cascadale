import { describe, expect, test } from "vitest"

import { simulate } from "@/lib/plan"
import { categoryCosts, monthBudget, spareCash } from "@/lib/plan-budget"
import { checkPurchase, livePlan } from "@/lib/plan-service"

import { currentSnapshot, TODAY } from "./fixtures/october-2026"
import { harness } from "./harness"

describe("monthBudget", () => {
  const costs = [
    { category: "Groceries", bills: 0, dayToDay: 900, budget: null },
    { category: "Rent", bills: 2400, dayToDay: 0, budget: null },
    { category: "Dining Out", bills: 0, dayToDay: 200, budget: 150 },
  ]

  test("measures each category against its budget, or the plan's amount without one", () => {
    const m = monthBudget(
      costs,
      [
        { id: 1, name: "Groceries", spent: 450 },
        { id: 2, name: "Rent", spent: 2400 },
        { id: 3, name: "Dining Out", spent: 180 },
        { id: 4, name: "Hobbies", spent: 60 },
        { id: null, name: "Uncategorized", spent: 75 },
      ],
      "2026-11-15"
    )
    const line = (c: string) => m.lines.find((l) => l.category === c)!
    expect(line("Groceries")).toMatchObject({ limit: 900, fromBudget: false, left: 450, status: "ok" })
    // a bill paid in full early is on plan, not ahead of pace
    expect(line("Rent").status).toBe("ok")
    expect(line("Dining Out")).toMatchObject({ limit: 150, fromBudget: true, left: -30, status: "over" })
    expect(line("Hobbies").status).toBe("unplanned")
    expect(m.uncategorized).toBe(75)
    expect(m.daysLeft).toBe(16)
    expect(m.anyBudgets).toBe(true)
  })

  test("flags day-to-day spending running well ahead of the month's pace", () => {
    const m = monthBudget(costs, [{ id: 1, name: "Groceries", spent: 600 }], "2026-11-05")
    expect(m.lines.find((l) => l.category === "Groceries")!.status).toBe("ahead")
  })
})

describe("checkPurchase", () => {
  async function spare() {
    const live = (await livePlan(harness().deps))!
    return spareCash(live.snapshot, simulate(live.snapshot, live.plan))!
  }

  test("says yes to something the spare cash covers, and shows what it costs the plan's end", async () => {
    const { amount } = await spare()
    expect(amount).toBeGreaterThan(100)
    const out = await checkPurchase(harness().deps, { name: "Jacket", amount: 100 }, null, TODAY)
    expect(out.verdict).toBe("yes")
    expect(out.spareCash.after).toBeCloseTo(out.spareCash.before! - 100, 1)
    expect(out.end.after.net).toBeCloseTo(out.end.before.net - 100, 1)
  })

  test("says no to something no payday in the projection makes room for", async () => {
    const out = await checkPurchase(harness().deps, { name: "Boat", amount: 10_000_000 }, null, TODAY)
    expect(out.verdict).toBe("no")
    expect(out.earliestDate).toBeNull()
  })

  test("flags a purchase that fits the cash but breaks the category's month", async () => {
    const [cost] = categoryCosts(currentSnapshot())
    // the category's month already spent in full, so even a small extra breaks it
    const out = await checkPurchase(
      harness().deps,
      { name: "Extra", amount: 10, category: cost.category.toUpperCase() },
      [{ id: 1, name: cost.category, spent: cost.dayToDay + cost.bills }],
      TODAY
    )
    expect(out.budget).toMatchObject({ category: cost.category, leftBefore: 0 })
    expect(out.verdict).toBe("over_budget")
  })
})
