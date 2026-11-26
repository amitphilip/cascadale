import { describe, expect, test } from "vitest"

import { parseWhatIfId, whatIf, whatIfId } from "@/lib/planning/what-if"
import { CHECK, EMERGENCY, SAVING, TODAY, goals, ipad, position } from "./fixtures/amit-cycle"

const run = (balance: number, request = ipad, spending = 900) =>
  whatIf({
    today: TODAY,
    request,
    position: position(balance),
    future: { days: 14, income: 5122.36, moves: 3065, bills: 400, spending },
    payEvery: "fortnight",
    balances: new Map([
      [CHECK, balance],
      [EMERGENCY, 547.58],
    ]),
    accountName: new Map([[CHECK, "Check Account - Amit"]]),
    mine: new Set([CHECK, SAVING]),
    goals,
    buffers: [{ accountId: EMERGENCY, name: "Emergency GO", balance: 547.58, ratePerWeek: 20, theirs: false }],
    card: null,
    oneOffAccountId: null,
  })

describe("cyclePosition", () => {
  const p = position(2567.36)

  test("the moves still to make and the bills before payday come off the pay account", () => {
    expect(p.moves.map((m) => [m.id, m.left])).toEqual([
      [110, 0],
      [111, 130],
      [123, 275],
      [130, 105],
    ])
    expect(p.movesLeft).toBe(510)
    expect(p.billsDue.map((b) => [b.name, b.date])).toEqual([
      ["Mercury", "2026-12-02"],
      ["AIA", "2026-12-08"],
      ["Spark", "2026-12-08"],
    ])
    // 2,567.36 − 510 of moves − 622.15 of bills
    expect(p.leftInPayAccount).toBe(1435.21)
    expect(p.uncovered).toEqual([])
    expect(p.cycle).toMatchObject({ start: "2026-11-25", end: "2026-12-09", daysLeft: 13 })
  })

  test("what the pay account can't cover is listed when it falls due", () => {
    const short = position(700)
    // 700 less 510 of moves leaves 190: Mercury is 196.68 short, then the 8th's bills in full
    expect(short.uncovered.map((u) => [u.title, u.short])).toEqual([
      ["Mercury", 196.68],
      ["Spark", 94.99],
      ["AIA", 140.48],
    ])
  })
})

describe("whatIf: a $1,200 iPad on Amit's current cycle", () => {
  test("returns a verdict and saves nothing: the id carries the request", () => {
    const r = run(2567.36)
    expect(["affordable", "affordable_with_changes", "not_affordable"]).toContain(r.verdict)
    expect(r.whatIfId).toBe(whatIfId(ipad))
    expect(parseWhatIfId(r.whatIfId)).toEqual(ipad)
    expect(r.thisCycle).toMatchObject({ leftAfterBillsAndMoves: 1435.21, afterPurchase: 235.21, nextPayday: "2026-12-09" })
  })

  test("with room for it and the usual spending, it's affordable as it is", () => {
    const r = run(4655.74, ipad, 900)
    expect(r.verdict).toBe("affordable")
    expect(r.recommended).toBe("pay_now")
    expect(r.changes).toEqual([])
  })

  test("when paying now squeezes the usual spending, it's yes if: spread it over three pays", () => {
    const r = run(2567.36)
    expect(r.verdict).toBe("affordable_with_changes")
    // the next pay leaves 757.36 after moves, bills and usual spending: not enough on its own
    expect(r.options.find((o) => o.id === "wait_until_next_pay")).toMatchObject({ feasible: false, nextCyclesLeft: [-442.64, 757.36, 757.36] })
    expect(r.recommended).toBe("spread_over_3")
    expect(r.changes).toEqual(["Add 400.00 a pay towards iPad for 3 pays, ending 2026-12-23 (a plan change to approve)"])
    expect(r.headline).toMatch(/^Yes if: put aside 400\.00 from each of 3 pays/)
    const ids = r.options.map((o) => o.id)
    expect(ids).toEqual(expect.arrayContaining(["pay_now", "wait_until_next_pay", "spread_over_2", "spread_over_3", "use_buffer", "pause_goal"]))
    // the knock-on: holding back the savings and the AOC move this pay, and the weeks it costs them
    const pause = r.options.find((o) => o.id === "pause_goal")!
    expect(pause.shortTerm.map((l) => [l.planItemId, l.amount])).toEqual([[130, 0], [123, expect.any(Number)]])
    expect(pause.goalDelays[0]).toEqual({ goal: "Everyday Saving", weeks: 2 })
    expect(r.goals.find((g) => g.name === "Everyday Saving")!.delayWeeks.pause_goal).toBe(2)
  })

  test("spreading it is a long-term change (a pending plan item), not a short-term one", () => {
    const spread = run(2567.36).options.find((o) => o.id === "spread_over_3")!
    expect(spread.shortTerm).toEqual([])
    expect(spread.plan).toEqual([
      expect.objectContaining({ purpose: "one_off", amount: 400, every: "fortnight", fromAccountId: CHECK, endDate: "2026-12-23" }),
    ])
  })

  test("with too little now and next pay, it's not affordable", () => {
    const r = whatIf({
      ...{ today: TODAY, request: { ...ipad, amount: 9000 }, position: position(700) },
      future: { days: 14, income: 5122.36, moves: 3065, bills: 400, spending: 1500 },
      payEvery: "fortnight",
      balances: new Map([[CHECK, 700]]),
      accountName: new Map(),
      mine: new Set([CHECK]),
      goals: [],
      buffers: [],
      card: null,
      oneOffAccountId: null,
    })
    expect(r.verdict).toBe("not_affordable")
    expect(r.recommended).toBeNull()
    expect(r.thisCycle.uncoveredIfPaidNow.length).toBeGreaterThan(0)
  })
})
