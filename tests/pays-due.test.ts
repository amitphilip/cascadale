import { describe, expect, test } from "vitest"

import { expectedFrom, paysDue } from "@/lib/income"

const MONTH_END = "2026-11-30"

const pay = (example: string, cadence: "fortnightly" | "monthly", nextDate: string, latest: number) => ({
  example,
  accountId: 1,
  cadence,
  nextDate,
  latest,
})

describe("paysDue", () => {
  test("a fortnightly pay still ahead this month counts; a monthly one next month doesn't", () => {
    const due = paysDue(
      [pay("Wood Partners", "fortnightly", "2026-11-25", 5122.36), pay("Fph Ltd", "monthly", "2026-12-19", 6070.44)],
      "2026-11-23",
      MONTH_END
    )
    expect(due).toEqual([
      { name: "Wood Partners", accountId: 1, date: "2026-11-25", amount: 5122.36, status: "due" },
    ])
    expect(expectedFrom(due)).toBe(5122.36)
  })

  test("a fortnightly pay early in the month comes twice", () => {
    const due = paysDue([pay("Wood Partners", "fortnightly", "2026-11-11", 5000)], "2026-11-02", MONTH_END)
    expect(due.map((p) => p.date)).toEqual(["2026-11-11", "2026-11-25"])
    expect(expectedFrom(due)).toBe(10000)
  })

  test("a pay a few days past its payday is late and still counted", () => {
    const due = paysDue([pay("Wood Partners", "fortnightly", "2026-11-20", 5000)], "2026-11-23", MONTH_END)
    expect(due).toMatchObject([{ date: "2026-11-20", status: "late" }])
    expect(expectedFrom(due)).toBe(5000)
  })

  test("a pay well past its payday this month is missed and not counted on", () => {
    const due = paysDue([pay("Fph Ltd", "monthly", "2026-11-05", 6000)], "2026-11-23", MONTH_END)
    expect(due).toMatchObject([{ date: "2026-11-05", status: "missed" }])
    expect(expectedFrom(due)).toBe(0)
  })

  test("a payday from last month just missed is still late; one long gone is dropped for this month's", () => {
    expect(
      paysDue([pay("Wood Partners", "fortnightly", "2026-10-30", 5000)], "2026-11-02", MONTH_END)
    ).toMatchObject([
      { date: "2026-10-30", status: "late" },
      { date: "2026-11-13", status: "due" },
      { date: "2026-11-27", status: "due" },
    ])
    expect(
      paysDue([pay("Fph Ltd", "monthly", "2026-10-10", 6000)], "2026-11-23", MONTH_END)
    ).toMatchObject([{ date: "2026-11-09", status: "missed" }])
  })
})
