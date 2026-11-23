import { describe, expect, it } from "vitest"

import { payCadence, paydayNudge, perPay, weeklyNudge } from "@/supabase/functions/_shared/nudges"

const money = (n: number) => `$${Math.round(n).toLocaleString("en-NZ")}`
const day = (iso: string) => iso

describe("payCadence", () => {
  it("reads a fortnightly pay from the last similar one", () => {
    expect(payCadence("2026-11-25", 5122.36, [{ date: "2026-11-11", amount: 5100 }, { date: "2026-10-28", amount: 5122.36 }])).toBe("fortnight")
  })
  it("reads a monthly pay", () => {
    expect(payCadence("2026-12-19", 6070.44, [{ date: "2026-11-19", amount: 6070.44 }])).toBe("month")
  })
  it("ignores income of a different size", () => {
    expect(payCadence("2026-11-25", 5122.36, [{ date: "2026-11-18", amount: 900 }])).toBeNull()
  })
})

describe("perPay", () => {
  it("turns a monthly amount into a fortnightly pay's share", () => {
    expect(perPay(1300, "month", "fortnight")).toBeCloseTo(600)
  })
  it("keeps an amount on the pay's own cadence", () => {
    expect(perPay(200, "fortnight", "fortnight")).toBe(200)
  })
})

describe("paydayNudge", () => {
  const pay = { id: 900, date: "2026-11-25", amount: 5122.36, description: "Wood Partners Consu WoodiPayroll", accountId: 1 }

  it("lists what the plan moves out of the account the pay landed in, per pay", () => {
    const n = paydayNudge({
      pay,
      accountName: "Check Account - Amit",
      cadence: "fortnight",
      moves: [
        { title: "Joint paydown", amount: 200, every: "fortnight", toAccount: "Check Account - Joint", fromAccountId: 1 },
        { title: "Emergency GO", amount: 500, every: "month", toAccount: "Emergency GO", fromAccountId: 1 },
        { title: "Sharesies", amount: 950, every: "month", toAccount: null, fromAccountId: 67 },
        { title: "AOC lump sum", amount: 2060, every: "once", toAccount: "AOC", fromAccountId: 1 },
      ],
      money,
    })
    expect(n.dedupeKey).toBe("payday:900")
    expect(n.title).toBe("$5,122 landed in Check Account - Amit")
    // 500/month is 230.77 a fortnight, rounded to the nearest $5
    expect(n.body).toContain("• $200 → Check Account - Joint (Joint paydown)")
    expect(n.body).toContain("• $230 → Emergency GO")
    expect(n.body).not.toContain("Sharesies")
    expect(n.body).not.toContain("AOC")
    expect(n.body).toContain("That leaves $4,692 in Check Account - Amit")
    expect(n.push).toBe("Move $430 in 2 transfers. Tap for the list.")
  })

  it("asks for the plan to be redone when it doesn't say what moves from here", () => {
    const n = paydayNudge({ pay, accountName: "Check Account - Amit", cadence: null, moves: [], money })
    expect(n.body).toContain("Ask Cas to redo the plan")
  })
})

describe("weeklyNudge", () => {
  const base = { monday: "2026-11-23", monthGone: 22 / 30, unbudgeted: [], dueSoon: [], todosDue: 0, money, day }

  it("leads with what's over and names unbudgeted spending", () => {
    const n = weeklyNudge({
      ...base,
      budgets: [
        { name: "Entertainment", budget: 100, spent: 358.93, period: "month" },
        { name: "Groceries", budget: 719, spent: 768.74, period: "month" },
        { name: "Dining Out", budget: 1500, spent: 1154.22, period: "month" },
      ],
      unbudgeted: [{ name: "Travel", spent: 2069.97 }],
      dueSoon: [{ name: "Auckland Council rates", total: 887.93, date: "2026-11-30" }],
    })!
    expect(n.dedupeKey).toBe("weekly:2026-11-23")
    expect(n.body.split("\n")[0]).toBe("Over budget: Entertainment by $259, Groceries by $50.")
    expect(n.body).toContain("No budget for: Travel $2,070 this month.")
    expect(n.body).toContain("Due in the next two weeks: Auckland Council rates $888 on 2026-11-30.")
    expect(n.push).toBe("2 over budget (Entertainment by $259), $2,070 unbudgeted.")
  })

  it("says so when everything's on pace", () => {
    const n = weeklyNudge({ ...base, budgets: [{ name: "Groceries", budget: 719, spent: 400, period: "month" }] })!
    expect(n.body).toBe("Every budget is on pace this month.")
    expect(n.push).toBe("Every budget is on pace. Nothing big due.")
  })
})
