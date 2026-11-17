import { describe, expect, test } from "vitest"

import { inDates, outDates, planOneOff, step } from "@/lib/one-offs"

const oneOff = (o: Partial<Parameters<typeof planOneOff>[0]> = {}) => ({
  total: 1200,
  startDate: "2026-11-01",
  finishDate: "2027-03-01",
  outMode: "single" as const,
  outEvery: null,
  inEvery: "month" as const,
  setAside: 0,
  ...o,
})

const tx = (id: number, date: string, amount: number) => ({ id, date, amount, description: "TFR" })

describe("step", () => {
  test("months step from the date itself, so the end of a month doesn't drift", () => {
    expect(step("2026-01-31", "month", 1)).toBe("2026-02-28")
    expect(step("2026-01-31", "month", 2)).toBe("2026-03-31")
    expect(step("2026-03-01", "fortnight", -1)).toBe("2026-02-15")
  })
})

describe("outDates", () => {
  test("a spread one is paid every period back from the finish date, not before the start", () => {
    const o = oneOff({ outMode: "spread", outEvery: "month", startDate: "2026-11-18" })
    expect(outDates(o, "2026-11-18")).toEqual(["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"])
    expect(outDates(o, "2027-01-02")).toEqual(["2027-02-01", "2027-03-01"])
  })

  test("once every payment date has passed, what's left is due today", () => {
    expect(outDates(oneOff(), "2027-03-05")).toEqual(["2027-03-05"])
  })
})

describe("inDates", () => {
  test("contributions run from the start date, counting only today on, up to the last payment", () => {
    expect(inDates(oneOff(), "2026-11-18", "2027-03-01")).toEqual([
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
      "2027-03-01",
    ])
  })
})

describe("planOneOff", () => {
  test("one payment: the total is split over the contributions before it", () => {
    const plan = planOneOff(oneOff(), [], "2026-11-01")
    expect(plan.status).toBe("on_track")
    expect(plan.moves).toEqual([
      { date: "2026-11-01", kind: "in", amount: 240 },
      { date: "2026-12-01", kind: "in", amount: 240 },
      { date: "2027-01-01", kind: "in", amount: 240 },
      { date: "2027-02-01", kind: "in", amount: 240 },
      { date: "2027-03-01", kind: "in", amount: 240 },
      { date: "2027-03-01", kind: "out", amount: 1200 },
    ])
  })

  test("what's been put in and set aside comes off what's still to put in", () => {
    const plan = planOneOff(oneOff({ setAside: 200 }), [tx(1, "2026-11-01", 200)], "2026-11-18")
    expect(plan.held).toBe(400)
    expect(plan.toPutIn).toBe(800)
    expect(plan.moves.filter((m) => m.kind === "in").map((m) => m.amount)).toEqual([200, 200, 200, 200])
  })

  test("spread payments: each is funded by the contributions since the one before", () => {
    const o = oneOff({ total: 600, outMode: "spread", outEvery: "month", inEvery: "fortnight", startDate: "2027-01-01" })
    const plan = planOneOff(o, [], "2027-01-01")
    expect(plan.moves).toEqual([
      { date: "2027-01-01", kind: "in", amount: 100 },
      { date: "2027-01-15", kind: "in", amount: 100 },
      { date: "2027-01-29", kind: "in", amount: 100 },
      { date: "2027-02-01", kind: "out", amount: 300 },
      { date: "2027-02-12", kind: "in", amount: 150 },
      { date: "2027-02-26", kind: "in", amount: 150 },
      { date: "2027-03-01", kind: "out", amount: 300 },
    ])
  })

  test("a payment paid out leaves the rest over the payments still to come", () => {
    const o = oneOff({ total: 900, outMode: "spread", outEvery: "month", startDate: "2027-01-01" })
    const linked = [tx(1, "2027-01-01", 300), tx(2, "2027-01-01", -300)]
    const plan = planOneOff(o, linked, "2027-01-20")
    expect(plan.paidOut).toBe(300)
    expect(plan.remaining).toBe(600)
    expect(plan.moves.filter((m) => m.kind === "out")).toEqual([
      { date: "2027-02-01", kind: "out", amount: 300 },
      { date: "2027-03-01", kind: "out", amount: 300 },
    ])
  })

  test("a payment due before the next contribution needs the money now", () => {
    const o = oneOff({ total: 500, startDate: "2026-11-01", finishDate: "2026-11-25" })
    const plan = planOneOff(o, [], "2026-11-18")
    expect(plan.status).toBe("catch_up")
    expect(plan.moves[0]).toEqual({ date: "2026-11-18", kind: "in", amount: 500, now: true })
  })

  test("held money pays the earliest payments first, and more than enough is a surplus", () => {
    const o = oneOff({ total: 600, outMode: "spread", outEvery: "month", startDate: "2027-01-01" })
    const plan = planOneOff(o, [tx(1, "2027-01-01", 450)], "2027-01-01")
    expect(plan.moves.filter((m) => m.kind === "in")).toEqual([
      { date: "2027-02-01", kind: "in", amount: 75 },
      { date: "2027-03-01", kind: "in", amount: 75 },
    ])
    expect(planOneOff(o, [tx(1, "2027-01-01", 700)], "2027-01-01").surplus).toBe(100)
  })

  test("paid in full, and overdue once the finish date passes with some left", () => {
    expect(planOneOff(oneOff(), [tx(1, "2027-03-01", -1200)], "2027-03-02").status).toBe("paid")
    const late = planOneOff(oneOff(), [tx(1, "2027-03-01", 1200)], "2027-03-05")
    expect(late.status).toBe("overdue")
    expect(late.moves).toEqual([{ date: "2027-03-05", kind: "out", amount: 1200 }])
  })

  test("odd cents land on the first parts", () => {
    const o = oneOff({ total: 100, outMode: "spread", outEvery: "month", startDate: "2027-01-01", finishDate: "2027-03-01" })
    const plan = planOneOff(o, [], "2027-01-01")
    expect(plan.moves.filter((m) => m.kind === "out").map((m) => m.amount)).toEqual([33.34, 33.33, 33.33])
  })
})
