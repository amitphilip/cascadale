import { describe, expect, test } from "vitest"

import type { Plan, PlanSnapshot } from "@/lib/plan"
import { goalPlan, planGoal } from "@/lib/plan-goal"

const plan: Plan = { summary: "Keep it steady", set_asides: [], focus: [], warnings: [] }

const snapshot = (over: Partial<PlanSnapshot>): PlanSnapshot => ({
  start: "2026-10-01",
  dataEnd: "2026-09-30",
  currency: "NZD",
  accounts: [
    { id: 1, name: "Everyday", type: "checking", balance: 1000 },
    { id: 2, name: "Mortgage", type: "loan", balance: -300000 },
  ],
  incomes: [],
  bills: [],
  variable: [],
  otherIncome: [],
  budgets: [],
  ...over,
})

describe("planGoal", () => {
  const goal = { snapshot: snapshot({}), plan }

  test("tracks actual against the plan day by day, loans left out", () => {
    const current = snapshot({
      start: "2026-10-04",
      dataEnd: "2026-10-03",
      accounts: [
        { id: 1, name: "Everyday", type: "checking", balance: 800 },
        { id: 2, name: "Mortgage", type: "loan", balance: -299000 },
      ],
    })
    const g = planGoal({
      goal,
      latest: plan,
      current,
      balances: new Map([
        [1, 800],
        [2, -299000],
      ]),
      txs: [
        { accountId: 1, date: "2026-10-02", amount: -200 },
        { accountId: 2, date: "2026-10-02", amount: 1000 },
      ],
    })
    expect(g.target).toBe(1000)
    expect(g.endDate).toBe("2026-12-29")
    expect(g.days.slice(0, 5)).toEqual([
      { date: "2026-09-30", planned: 1000, actual: 1000, forecast: null },
      { date: "2026-10-01", planned: 1000, actual: 1000, forecast: null },
      { date: "2026-10-02", planned: 1000, actual: 800, forecast: null },
      { date: "2026-10-03", planned: 1000, actual: 800, forecast: 800 },
      { date: "2026-10-04", planned: 1000, actual: null, forecast: 800 },
    ])
    expect(g.forecast).toBe(800)
    expect(g.gap).toBe(-200)
    expect(g.latest).toEqual({
      date: "2026-10-03",
      planned: 1000,
      actual: 800,
      cash: 800,
      owed: 0,
    })
    expect(g.tone).toBe("off_track")
  })

  test("a revolving credit below zero counts as owed, and paying it down leaves net unchanged", () => {
    const accounts = [
      { id: 1, name: "Everyday", type: "checking", balance: 3000 },
      { id: 3, name: "Joint", type: "checking", balance: -20000 },
    ]
    const g = planGoal({
      goal: { snapshot: snapshot({ accounts }), plan },
      latest: plan,
      current: snapshot({ start: "2026-10-03", dataEnd: "2026-10-02", accounts }),
      balances: new Map([
        [1, 2200],
        [3, -19200],
      ]),
      txs: [
        { accountId: 1, date: "2026-10-02", amount: -800 },
        { accountId: 3, date: "2026-10-02", amount: 800 },
      ],
    })
    expect(g.targetSplit).toEqual({ cash: 3000, owed: -20000 })
    expect(g.latest).toEqual({
      date: "2026-10-02",
      planned: -17000,
      actual: -17000,
      cash: 2200,
      owed: -19200,
    })
    expect(g.gap).toBe(0)
    expect(g.tone).toBe("on_track")
  })

  test("the plan you started sets the goal until its horizon passes", () => {
    const rebuilt = { snapshot: snapshot({ start: "2026-11-01" }), plan }
    expect(goalPlan(goal, rebuilt, "2026-12-01")).toBe(goal)
    expect(goalPlan(goal, rebuilt, "2027-01-15")).toBe(rebuilt)
    expect(goalPlan(null, rebuilt, "2026-12-01")).toBe(rebuilt)
  })
})
