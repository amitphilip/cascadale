import { describe, expect, test } from "vitest"

import type { Category } from "@/lib/db/schema"
import type { PayDue } from "@/lib/income"
import { monthFigures } from "@/lib/month-figures"
import type { CategoryFigure } from "@/lib/plan-figures"
import type { SpendTx } from "@/lib/queries"
import { digestQueue } from "@/supabase/functions/_shared/cas-queue"

// Wed 11 Nov 2026: 11 of 30 days gone, so 19/30 of the month is left
const TODAY = "2026-11-11"

const cat = (id: number, name: string, kind: Category["kind"], monthlyBudget: number | null = null): Category => ({
  id,
  name,
  kind,
  monthlyBudget,
  weeklyBudget: null,
  budgetPercent: null,
})
const CATEGORIES = [
  cat(1, "Groceries", "expense", 900),
  cat(2, "Rent", "expense", 2400),
  cat(3, "Dining out", "expense"),
  cat(4, "Salary", "income"),
]
const PROJECTION: CategoryFigure[] = [
  { categoryId: 1, name: "Groceries", projected: 880, budget: 900, budgetPeriod: "month", budgetPercent: null, recurring: 0 },
  { categoryId: 2, name: "Rent", projected: 2400, budget: 2400, budgetPeriod: "month", budgetPercent: null, recurring: 2400 },
  { categoryId: 3, name: "Dining out", projected: 150, budget: null, budgetPeriod: null, budgetPercent: null, recurring: 0 },
]

let nextId = 1
const tx = (date: string, description: string, amount: number, categoryId: number | null, extra: Partial<SpendTx> = {}): SpendTx => ({
  id: nextId++,
  date,
  description,
  amount,
  accountId: 1,
  categoryId,
  categorySource: "rule",
  oneOffId: null,
  ...extra,
})

const pay = (date: string, amount: number, status: PayDue["status"] = "due"): PayDue => ({
  name: "Wood Partners",
  accountId: 1,
  date,
  amount,
  status,
})

function figures(over: Partial<Parameters<typeof monthFigures>[0]> = {}) {
  return monthFigures({
    today: TODAY,
    txs: [
      tx("2026-11-02", "COUNTDOWN QUEEN ST 1234", -200, 1),
      tx("2026-11-09", "COUNTDOWN QUEEN ST 5678", -100, 1),
      tx("2026-11-10", "PAK N SAVE ALBANY", -60, 1),
      tx("2026-11-03", "COUNTDOWN QUEEN ST 9999", 20, 1),
      tx("2026-11-01", "RENT AUTOPAY", -1200, 2),
      tx("2026-11-04", "UBER EATS", -45, 3),
      tx("2026-11-05", "Mystery debit", -30, null),
      tx("2026-11-11", "WOOD PARTNERS SALARY", 5000, 4),
      tx("2026-11-06", "AIR NEW ZEALAND", -800, 3, { oneOffId: 7 }),
      // last week of October: this week starts Mon 9 Nov, so it isn't counted
      tx("2026-10-30", "COUNTDOWN QUEEN ST", -99, 1),
    ],
    categories: CATEGORIES,
    projection: PROJECTION,
    paysDue: [pay("2026-11-25", 5000)],
    billsDue: [{ name: "Rent", accountId: 1, date: "2026-11-15", amount: 1200, status: "due", categoryId: 2 }],
    oneOffs: [{ id: 7, name: "Japan trip", outThisMonth: 400 }],
    mine: null,
    ...over,
  })
}

describe("monthFigures", () => {
  test("money in so far and expected by the month's end", () => {
    const f = figures()
    expect(f.in.soFar).toBe(5000)
    expect(f.in.expected).toBe(10000)
  })

  test("a missed pay isn't counted on", () => {
    expect(figures({ paysDue: [pay("2026-11-01", 5000, "missed")] }).in.expected).toBe(5000)
  })

  test("money out so far: category spending net of refunds, uncategorized and one-offs paid", () => {
    // groceries 340, rent 1200, dining 45, uncategorized 30, Japan trip 800
    expect(figures().out.soFar).toBe(2415)
  })

  test("out expected is each budget, or the projection without one, plus one-offs this month", () => {
    // 900 + 2400 + 150 + Japan trip 800 paid + 400 still to pay
    expect(figures().out.planned).toBe(4650)
  })

  test("out projected: spent, plus bills still due, plus everyday spending for the days left", () => {
    const left = 19 / 30
    const expected = 340 + 900 * left + (1200 + 1200) + (45 + 150 * left) + 30 + 800 + 400
    const f = figures()
    expect(f.out.projected).toBeCloseTo(expected, 1)
    expect(f.out.diff).toBeCloseTo(expected - 4650, 1)
    expect(f.net).toBeCloseTo(10000 - expected, 1)
  })

  test("a month run exactly to plan projects to the plan", () => {
    const f = monthFigures({
      today: TODAY,
      txs: [tx("2026-11-05", "COUNTDOWN", -(900 * 11) / 30, 1)],
      categories: [cat(1, "Groceries", "expense", 900)],
      projection: [PROJECTION[0]],
      paysDue: [],
      billsDue: [],
      oneOffs: [],
      mine: null,
    })
    expect(f.out.diff).toBeCloseTo(0, 1)
  })

  test("budget rows: everyday and bills, with spending by merchant", () => {
    const rows = figures().rows
    const groceries = rows.find((r) => r.categoryId === 1)!
    expect(groceries).toMatchObject({ group: "everyday", spent: 340, budget: 900 })
    expect(groceries.merchants.map((m) => [m.name, m.spent, m.txs.length])).toEqual([
      ["Countdown Queen St", 280, 3],
      ["Pak Save Albany", 60, 1],
    ])
    expect(rows.find((r) => r.categoryId === 2)).toMatchObject({ group: "bills", spent: 1200, due: 1200 })
  })

  test("spending with no budget and uncategorized get rows, uncategorized last", () => {
    const everyday = figures().rows.filter((r) => r.group === "everyday")
    expect(everyday.map((r) => r.name)).toEqual(["Groceries", "Dining out", "Uncategorized"])
    expect(everyday.find((r) => r.name === "Dining out")).toMatchObject({ budget: null, spent: 45 })
  })

  test("a one-off payment's row: paid this month and what's still to pay", () => {
    const trip = figures().rows.find((r) => r.oneOffId === 7)!
    expect(trip).toMatchObject({ group: "one_offs", spent: 800, due: 400, budget: 1200 })
    expect(trip.merchants[0].name).toBe("Air New Zealand")
  })

  test("left to spend counts everyday budgets and unbudgeted spending, not bills", () => {
    // 900 budget less 340 groceries and 45 unbudgeted dining
    expect(figures().leftToSpend).toMatchObject({ budgeted: 900, spent: 340, unbudgeted: 45, amount: 515 })
  })

  test("your line counts only your accounts", () => {
    const f = figures({ mine: [2] })
    expect(f.yours).toEqual({ in: 0, out: 0 })
  })
})

describe("digestQueue", () => {
  const names = { category: (id: number) => ["", "Groceries", "Rent", "Dining out"][id], oneOff: () => "Japan trip" }
  const move = (id: number, merchantKey: string, to: { cat?: number; oneOff?: number }, remember = false) => ({
    id,
    merchantKey,
    toCategoryId: to.cat ?? null,
    toOneOffId: to.oneOff ?? null,
    remember,
    createdAt: `2026-11-1${id}T00:00:00Z`,
  })

  test("a remembered move becomes the merchant's rule; the latest one wins", () => {
    const d = digestQueue(
      [move(1, "uber eats", { cat: 1 }, true), move(2, "uber eats", { cat: 3 }, true)],
      names
    )
    expect(d.rules).toEqual([{ merchantKey: "uber eats", categoryId: 3 }])
    expect(d.outcomes.map((o) => o.outcome)).toEqual([
      "Replaced by a later move: Uber Eats goes to Dining out.",
      "Uber Eats now goes to Dining out by rule.",
    ])
  })

  test("one-time moves and one-off moves set no rules", () => {
    const d = digestQueue([move(1, "countdown", { cat: 3 }), move(2, "air new zealand", { oneOff: 7 })], names)
    expect(d.rules).toEqual([])
    expect(d.outcomes.map((o) => o.outcome)).toEqual([
      "Kept as a one-time move to Dining out.",
      "Counts towards Japan trip; Air New Zealand's other transactions are unchanged.",
    ])
  })
})
