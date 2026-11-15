import { describe, expect, test } from "vitest"

import type { PlanSnapshot, ScheduledEvent, Simulation } from "@/lib/plan"
import { budgetsNow, monthInOut, potsThisMonth, weekOf } from "@/lib/plan-month"
import type { PotLedger } from "@/lib/pots"

const event = (e: Partial<ScheduledEvent> & Pick<ScheduledEvent, "date" | "kind" | "name" | "amount">) =>
  ({ accountId: 1, pot: null, ...e }) as ScheduledEvent

const snap = (start: string) =>
  ({
    start,
    variable: [
      { category: "Groceries", accountId: 1, monthly: 900 },
      { category: "Fuel", accountId: 2, monthly: 300 },
    ],
  }) as unknown as PlanSnapshot

const sim = (events: ScheduledEvent[]) => ({ events }) as unknown as Simulation

describe("monthInOut", () => {
  const events = [
    event({ date: "2026-11-20", kind: "income", name: "Mary's pay", amount: 3100 }),
    event({ date: "2026-11-25", kind: "bill", name: "Power", amount: 180, pot: "Bills" }),
    event({ date: "2026-11-26", kind: "set-aside", name: "Bills", amount: 500, pot: "Bills" }),
    event({ date: "2026-11-28", kind: "bill", name: "Flights", amount: 900, accountId: 2, oneOff: true }),
    // next month's don't count
    event({ date: "2026-12-01", kind: "bill", name: "Rent", amount: 2400 }),
  ]

  test("adds what the plan still expects this month to what's happened", () => {
    const m = monthInOut({
      actual: { income: 4000, expense: 2500 },
      snap: snap("2026-11-16"),
      sim: sim(events),
      today: "2026-11-16",
    })
    expect(m.month).toBe("2026-11")
    expect(m.daysLeft).toBe(15)
    expect(m.in).toMatchObject({ received: 4000, toCome: 3100, expected: 7100 })
    expect(m.out.billsToCome).toBe(1080)
    // 1200 a month of day-to-day spending over 15 of November's 30 days
    expect(m.out.dayToDayToCome).toBe(600)
    expect(m.out.expected).toBe(2500 + 1080 + 600)
    expect(m.net).toBe(7100 - 4180)
    // set-asides move money between pots, so they're neither in nor out
    expect(m.out.items.map((i) => i.name)).toEqual(["Power", "Flights"])
    expect(m.out.items[1]).toMatchObject({ oneOff: true, pot: null })
  })

  test("with accounts, keeps to what lands in or leaves them", () => {
    const m = monthInOut({
      actual: { income: 0, expense: 100 },
      snap: snap("2026-11-16"),
      sim: sim(events),
      today: "2026-11-16",
      accounts: new Set([2]),
    })
    expect(m.in.toCome).toBe(0)
    expect(m.out.billsToCome).toBe(900)
    expect(m.out.dayToDayToCome).toBe(150)
  })

  test("on the month's last day with today's transactions in, nothing is still to come", () => {
    const m = monthInOut({
      actual: { income: 100, expense: 50 },
      snap: snap("2026-12-01"),
      sim: sim(events),
      today: "2026-11-30",
    })
    expect(m.month).toBe("2026-11")
    expect(m.daysLeft).toBe(0)
    expect(m.out).toMatchObject({ billsToCome: 0, dayToDayToCome: 0, expected: 50 })
  })
})

describe("weekOf", () => {
  test("runs Monday to Sunday", () => {
    expect(weekOf("2026-11-15")).toEqual({ start: "2026-11-09", end: "2026-11-16" })
    expect(weekOf("2026-11-16")).toEqual({ start: "2026-11-16", end: "2026-11-23" })
  })
})

describe("budgetsNow", () => {
  const categories = [
    { id: 1, name: "Groceries", kind: "expense", monthlyBudget: 650, weeklyBudget: 150 },
    { id: 2, name: "Dining Out", kind: "expense", monthlyBudget: 200, weeklyBudget: null },
    { id: 3, name: "Rent", kind: "expense", monthlyBudget: 2400, weeklyBudget: null },
    { id: 4, name: "Hobbies", kind: "expense", monthlyBudget: null, weeklyBudget: null },
    { id: 5, name: "Salary", kind: "income", monthlyBudget: null, weeklyBudget: null },
  ]
  const costs = [
    { category: "Rent", bills: 2400, dayToDay: 0, budget: 2400 },
    { category: "Groceries", bills: 0, dayToDay: 650, budget: 650 },
  ]

  // Wednesday 11 November: three days into the week, 11 days into the month
  const b = budgetsNow({
    categories,
    weekSpend: [{ id: 1, name: "Groceries", spent: 170 }],
    monthSpend: [
      { id: 1, name: "Groceries", spent: 400 },
      { id: 2, name: "Dining Out", spent: 150 },
      { id: 3, name: "Rent", spent: 2400 },
      { id: 4, name: "Hobbies", spent: 60 },
      { id: null, name: "Uncategorized", spent: 40 },
    ],
    costs,
    today: "2026-11-11",
  })

  test("measures a weekly budget against this week's spending, not the month's", () => {
    expect(b.week).toMatchObject({ start: "2026-11-09", daysLeft: 5, budget: 150, spent: 170 })
    expect(b.week.rows).toEqual([
      expect.objectContaining({ category: "Groceries", period: "week", spent: 170, left: -20, status: "over" }),
    ])
  })

  test("measures monthly budgets against the month, and a bill paid early isn't ahead of pace", () => {
    const row = (c: string) => b.month.rows.find((r) => r.category === c)!
    expect(b.month.rows.map((r) => r.category)).toEqual(["Dining Out", "Rent"])
    expect(row("Dining Out").status).toBe("ahead")
    expect(row("Rent")).toMatchObject({ status: "ok", left: 0 })
    expect(b.month.daysLeft).toBe(20)
  })

  test("totals spending without a budget apart", () => {
    expect(b.unbudgeted).toEqual([{ category: "Hobbies", spent: 60 }])
    expect(b.unbudgetedTotal).toBe(60)
    expect(b.uncategorized).toBe(40)
    expect(b.anyBudgets).toBe(true)
  })
})

describe("potsThisMonth", () => {
  const ledger = {
    pot: { id: 7, name: "Flights", cap: 3000 },
    today: "2026-11-15",
    lines: [
      { date: "2026-10-20", kind: "scheduled", amount: 200 },
      { date: "2026-11-01", kind: "scheduled", amount: 200 },
      { date: "2026-11-05", kind: "contribution", amount: 50 },
      { date: "2026-11-10", kind: "draw", amount: -320 },
    ],
    balance: 130,
    cap: { amount: 3000, remaining: 2680 },
    plannedDraws: [
      { entryId: 1, name: "Wellington trip", amount: 250, date: "2026-11-27" },
      { entryId: 2, name: "Christmas flights", amount: 900, date: "2026-12-15" },
    ],
    nextDraw: { entryId: 1, name: "Wellington trip", amount: 250, date: "2026-11-27" },
    shortfall: 0,
    warnings: [],
    ended: false,
  } as unknown as PotLedger

  test("shows what went in and out this month, and what's still to come before it ends", () => {
    const [p] = potsThisMonth({
      ledgers: [ledger],
      sim: sim([
        // on the ledger's day it's in the balance already
        event({ date: "2026-11-15", kind: "set-aside", name: "Flights", amount: 200, pot: "Flights" }),
        event({ date: "2026-11-29", kind: "set-aside", name: "Flights", amount: 200, pot: "Flights" }),
        event({ date: "2026-12-13", kind: "set-aside", name: "Flights", amount: 200, pot: "Flights" }),
      ]),
      today: "2026-11-15",
    })
    expect(p).toMatchObject({
      name: "Flights",
      in: 250,
      out: 320,
      inToCome: 200,
      outToCome: 250,
      balance: 130,
      cap: { amount: 3000, remaining: 2680 },
      nextDraw: { name: "Wellington trip" },
    })
  })
})
