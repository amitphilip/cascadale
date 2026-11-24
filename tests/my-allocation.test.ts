import { describe, expect, test } from "vitest"

import { myAllocation, type MoveTx } from "@/lib/my-allocation"

// Amit's November: a fortnightly pay into Check (1) on the 11th, the next due on the 25th
const CHECK = 1
const JOINT = 34
const AOC = 100
const CARD = 35
const SALARY = 1
const HOUSING = 4
const UTILITIES = 5
const DINING = 7
const TRANSFER = 20

const categories = [
  { id: SALARY, kind: "income" as const },
  { id: HOUSING, kind: "expense" as const },
  { id: UTILITIES, kind: "expense" as const },
  { id: DINING, kind: "expense" as const },
  { id: TRANSFER, kind: "transfer" as const },
]

let next = 1
const tx = (
  accountId: number,
  date: string,
  amount: number,
  categoryId: number | null,
  description = "TX"
): MoveTx => ({
  id: next++,
  accountId,
  date,
  amount,
  categoryId,
  description,
})

const txs = [
  tx(CHECK, "2026-11-11", 5122.36, SALARY, "Wood Partners"),
  // the plan's mortgage move, short of its $2,555
  tx(CHECK, "2026-11-11", -2020, TRANSFER, "MB TRANSFER TO JOINT"),
  tx(JOINT, "2026-11-11", 2020, TRANSFER, "MB TRANSFER EX CHECK"),
  // a card payment the plan doesn't name
  tx(CHECK, "2026-11-11", -1687, TRANSFER, "MB TRANSFER TO CARD 2699THANK YOU"),
  // round-ups, one a day
  tx(CHECK, "2026-11-22", -1, TRANSFER, "SAVETHECHANGE 21 Nov 26"),
  tx(CHECK, "2026-11-23", -0.61, TRANSFER, "SAVETHECHANGE 22 Nov 26"),
  // Cabin King, a category the plan moves weekly
  tx(CHECK, "2026-11-06", -60, HOUSING),
  tx(CHECK, "2026-11-13", -60, HOUSING),
  tx(CHECK, "2026-11-20", -60, HOUSING),
  tx(CHECK, "2026-11-02", -386.68, UTILITIES),
  tx(CHECK, "2026-11-12", -100.5, DINING),
  tx(CARD, "2026-11-12", -50, DINING),
]

const base = {
  today: "2026-11-24",
  mine: [CHECK],
  allocations: [
    {
      id: 110,
      title: "Mortgage and school fees",
      purpose: "bills" as const,
      amount: 2555,
      every: "fortnight" as const,
      categoryId: null,
      accountId: JOINT,
      fromAccountId: CHECK,
    },
    {
      id: 111,
      title: "Cabin King",
      purpose: "bills" as const,
      amount: 130,
      every: "fortnight" as const,
      categoryId: HOUSING,
      accountId: 108,
      fromAccountId: CHECK,
    },
    {
      id: 112,
      title: "Utilities",
      purpose: "bills" as const,
      amount: 634,
      every: "month" as const,
      categoryId: UTILITIES,
      accountId: CHECK,
      fromAccountId: null,
    },
    {
      id: 123,
      title: "AOC obstetrician fund",
      purpose: "one_off" as const,
      amount: 275,
      every: "fortnight" as const,
      categoryId: null,
      accountId: AOC,
      fromAccountId: CHECK,
    },
    {
      id: 125,
      title: "Joint paydown",
      purpose: "savings" as const,
      amount: 200,
      every: "fortnight" as const,
      categoryId: null,
      accountId: JOINT,
      fromAccountId: CHECK,
    },
    {
      id: 126,
      title: "Sharesies",
      purpose: "savings" as const,
      amount: 950,
      every: "month" as const,
      categoryId: null,
      accountId: null,
      fromAccountId: 67,
    },
  ],
  txs,
  categories,
  paysDue: [
    {
      name: "Wood Partners",
      accountId: CHECK,
      date: "2026-11-25",
      amount: 5122.36,
      status: "due" as const,
    },
  ],
  payEvery: new Map([[CHECK, "fortnight" as const]]),
  accountName: new Map([
    [JOINT, "Joint"],
    [AOC, "AOC"],
    [CARD, "Credit Card"],
  ]),
}

describe("myAllocation", () => {
  const a = myAllocation(base)
  const move = (id: number) => a.moves.find((m) => m.id === id)!

  test("your pay is what's landed in your accounts and what's still due", () => {
    expect(a.pay).toEqual({
      soFar: 5122.36,
      stillDue: 5122.36,
      total: 10244.72,
      next: { date: "2026-11-25", amount: 5122.36 },
    })
  })

  test("a move on your pay's cadence is per pay: two this month, one landed", () => {
    expect(move(110)).toMatchObject({
      month: 5110,
      byNow: 2555,
      done: 2020,
      status: "behind",
      to: "Joint",
    })
  })

  test("moves into the same account share what moved there, in plan order", () => {
    expect(move(125)).toMatchObject({
      month: 400,
      byNow: 200,
      done: 0,
      status: "behind",
    })
  })

  test("a move tied to a category counts that category's spending from the account", () => {
    expect(move(111)).toMatchObject({
      month: 260,
      byNow: 130,
      done: 180,
      status: "on_track",
    })
  })

  test("someone else's allocations aren't yours", () => {
    expect(a.moves.map((m) => m.id)).toEqual([110, 111, 123, 125])
  })

  test("a bill paid from your account counts its category's spending there", () => {
    expect(a.bills).toEqual([
      expect.objectContaining({
        id: 112,
        month: 634,
        done: 386.68,
        status: "on_track",
      }),
    ])
  })

  test("transfers out the plan doesn't name are other moves, by merchant", () => {
    expect(a.otherMoves.amount).toBe(1688.61)
    expect(a.otherMoves.parts.map((p) => p.amount)).toEqual([1687, 1.61])
    expect(a.otherMoves.parts[1].name).toBe("Savethechange Nov")
  })

  test("your spending is your pay less the plan, against the rest of your accounts' spending", () => {
    // 10,244.72 − (5,110 + 260 + 550 + 400 + 634); only Check's dining counts
    expect(a.planned).toBe(6954)
    expect(a.spending.allowance).toBe(3290.72)
    expect(a.spending.spent).toBe(100.5)
  })

  test("done so far counts the tracked moves and bills, capped at each one's month", () => {
    expect(a.done).toBe(2020 + 180 + 0 + 0 + 386.68)
  })

  test("by now counts the moves on the pays landed, and bills as they've gone", () => {
    // 2,555 + 130 + 275 + 200, and the utilities paid so far
    expect(a.byNow).toBe(3160 + 386.68)
  })

  test("a move done for the month is done", () => {
    const paid = myAllocation({
      ...base,
      txs: [
        ...txs,
        tx(CHECK, "2026-11-12", -550, TRANSFER),
        tx(AOC, "2026-11-12", 550, TRANSFER),
      ],
    })
    expect(paid.moves.find((m) => m.id === 123)).toMatchObject({
      done: 550,
      status: "done",
    })
  })
})
