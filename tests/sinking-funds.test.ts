import { describe, expect, test } from "vitest"

import { simulate } from "@/lib/plan"
import { livePlan } from "@/lib/plan-service"
import { currentCycle } from "@/lib/pots"

import { ACCOUNTS } from "./fixtures/october-2026"
import { harness } from "./harness"
import type { MemoryTx } from "./memory-repo"

/**
 * Sinking fund pots over the October 2026 fixture, as Claude uses them through the MCP
 * tools. The first use case: the AOC invoiced payments pool, capped at 7,500 to April 2027,
 * with 1,700 already paid on 2 Nov 2026.
 */

const TODAY = "2026-11-14"
const AOC_TX: MemoryTx = {
  id: 9001,
  date: "2026-11-02",
  description: "AOC INVOICE 2211",
  amount: -1700,
  accountId: ACCOUNTS.joint.id,
  category: "Health",
}
const TICKETS_TX: MemoryTx = {
  id: 9002,
  date: "2026-11-10",
  description: "AIR NZ BOOKING",
  amount: -950,
  accountId: ACCOUNTS.everyday.id,
  category: "Travel",
}
const REFUND_TX: MemoryTx = {
  id: 9003,
  date: "2026-11-12",
  description: "AIR NZ REFUND",
  amount: 150,
  accountId: ACCOUNTS.everyday.id,
  category: "Travel",
}

let op = 0
const next = () => `op-${++op}`

function setup(
  today = TODAY,
  transactions: MemoryTx[] = [AOC_TX, TICKETS_TX, REFUND_TX]
) {
  return harness({ today, transactions })
}

async function aocPool(h: ReturnType<typeof setup>, extra: object = {}) {
  return h.call("upsert_pot", {
    operationId: next(),
    name: "AOC",
    type: "sinking_fund",
    amount: 0,
    frequency: "monthly",
    cap: 7500,
    endDate: "2027-04",
    ...extra,
  })
}

describe("the AOC invoiced payments pool", () => {
  test("a 7,500 fund to April 2027 with the 1,700 linked shows 5,800 left and a monthly suggestion", async () => {
    const h = setup()
    const made = await aocPool(h)
    expect(made.changed.pot.after).toMatchObject({
      type: "sinking_fund",
      capAmount: 7500,
      endDate: "2027-04-30",
      scheduledFrom: TODAY,
    })
    expect(made.change.summary).toBe(
      "Added sinking fund AOC: 0 monthly, cap 7500 to 2027-04-30"
    )

    const linked = await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "aoc",
      transactionId: AOC_TX.id,
    })
    expect(linked.changed.entry.after).toMatchObject({
      kind: "draw",
      amount: 1700,
      transactionId: AOC_TX.id,
    })

    const l = await h.call("get_pot_ledger", { pot: "AOC" })
    expect(l.spent).toBe(1700)
    expect(l.balance).toBe(-1700)
    expect(l.cap).toMatchObject({
      amount: 7500,
      used: 1700,
      remaining: 5800,
      usedPct: 22.7,
    })
    // (cap - balance - spent) over the 1sts left: Dec, Jan, Feb, Mar, Apr
    expect(l.suggestion).toMatchObject({
      target: 7500,
      need: 7500,
      periods: 5,
      perPeriod: 1500,
      perMonth: 1500,
      onTrack: false,
    })
    expect(l.lines).toEqual([
      expect.objectContaining({
        date: "2026-11-02",
        kind: "draw",
        amount: -1700,
        balance: -1700,
        note: "AOC INVOICE 2211",
      }),
    ])
    // the ledger reconciles with the linked transactions
    expect(l.linked).toEqual({ count: 1, drawn: 1700, contributed: 0 })
    expect(l.warnings.join(" ")).toMatch(
      /needs \$1,500.00 a month to reach \$7,500.00 by 2027-04-30; nothing is scheduled/
    )
  })

  test("a scheduled contribution and a linked transfer in count towards it", async () => {
    const h = setup()
    await aocPool(h, {
      amount: 1500,
      fromAccountId: ACCOUNTS.joint.id,
      toAccountId: ACCOUNTS.streamline.id,
      startDate: "2026-11-01",
    })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "AOC",
      transactionId: AOC_TX.id,
    })
    const l = await h.call("get_pot_ledger", { pot: "AOC" })
    expect(
      l.lines.map((x: { kind: string; amount: number }) => [x.kind, x.amount])
    ).toEqual([
      ["scheduled", 1500],
      ["draw", -1700],
    ])
    expect(l.contributed).toBe(1500)
    expect(l.balance).toBe(-200)
    // 7,500 less 1,700 spent less -200 held, over five 1sts
    expect(l.suggestion).toMatchObject({
      need: 6000,
      perPeriod: 1200,
      onTrack: true,
    })
    expect(l.warnings).toEqual([])
  })
})

describe("draws", () => {
  test("a refund linked as a draw gives spend back, and unlinking returns it", async () => {
    const h = setup()
    await aocPool(h, { name: "Travel", cap: 2000, endDate: null })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "Travel",
      transactionId: TICKETS_TX.id,
    })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "Travel",
      transactionId: REFUND_TX.id,
      kind: "draw",
    })
    let l = await h.call("get_pot_ledger", { pot: "Travel" })
    expect(l.spent).toBe(800)
    expect(l.linked.drawn).toBe(800)

    await h.call("unlink_transaction_from_pot", {
      operationId: next(),
      transactionId: REFUND_TX.id,
    })
    l = await h.call("get_pot_ledger", { pot: "Travel" })
    expect(l.spent).toBe(950)
  })

  test("a transaction links to one fund only, and money in defaults to a contribution", async () => {
    const h = setup()
    await aocPool(h)
    await aocPool(h, { name: "Travel" })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "AOC",
      transactionId: AOC_TX.id,
    })
    await expect(
      h.call("link_transaction_to_pot", {
        operationId: next(),
        pot: "Travel",
        transactionId: AOC_TX.id,
      })
    ).rejects.toThrow("already linked to AOC")
    const out = await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "Travel",
      transactionId: REFUND_TX.id,
    })
    expect(out.changed.entry.after.kind).toBe("contribution")
    await expect(
      h.call("link_transaction_to_pot", {
        operationId: next(),
        pot: "Nope",
        transactionId: TICKETS_TX.id,
      })
    ).rejects.toThrow(
      /No sinking fund match "Nope". Sinking funds: AOC, Travel/
    )
  })

  test("linking a planned draw's transaction ticks the planned draw off", async () => {
    const h = setup()
    await aocPool(h)
    const planned = await h.call("add_pot_planned_draw", {
      operationId: next(),
      pot: "AOC",
      name: "November invoice",
      amount: 1700,
      date: "2026-11-02",
    })
    const id = planned.changed.entry.after.id
    let l = await h.call("get_pot_ledger", { pot: "AOC" })
    expect(l.plannedDraws).toEqual([
      expect.objectContaining({ entryId: id, overdue: true }),
    ])
    expect(l.warnings.join(" ")).toMatch(
      /November invoice on 2026-11-02 has passed/
    )

    const out = await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "AOC",
      transactionId: AOC_TX.id,
      plannedDrawId: id,
    })
    expect(out.plannedDrawDone.id).toBe(id)
    l = await h.call("get_pot_ledger", { pot: "AOC" })
    expect(l.plannedDraws).toEqual([])
    expect(l.lines[0].note).toBe("AOC INVOICE 2211")
  })
})

describe("cap and balance warnings", () => {
  test("planned draws beyond the cap warn on the ledger, the plan and get_plan", async () => {
    const h = setup()
    await aocPool(h, { amount: 1500, fromAccountId: ACCOUNTS.joint.id })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "AOC",
      transactionId: AOC_TX.id,
    })
    const out = await h.call("add_pot_planned_draw", {
      operationId: next(),
      pot: "AOC",
      name: "Spring invoices",
      amount: 6000,
      date: "2027-03-20",
    })
    const over =
      /spent and planned draws come to \$7,700.00, \$200.00 over its \$7,500.00 cap/
    expect(out.ledger.warnings.join(" ")).toMatch(over)
    expect(out.ledger.cap.remainingAfterPlanned).toBe(-200)

    const live = await livePlan(h.deps)
    expect(live!.plan.warnings.join(" ")).toMatch(over)
    const plan = await h.call("get_plan")
    expect(plan.sinkingFunds[0]).toMatchObject({
      pot: "AOC",
      capUsedPct: 22.7,
      capRemaining: 5800,
      plannedTotal: 6000,
    })
    expect(plan.sinkingFunds[0].warnings.join(" ")).toMatch(over)
  })

  test("warns when the balance won't cover the next planned draw", async () => {
    const h = setup()
    await aocPool(h, { amount: 500, fromAccountId: ACCOUNTS.joint.id })
    await h.call("add_pot_contribution", {
      operationId: next(),
      pot: "AOC",
      amount: 300,
      date: "2026-11-10",
    })
    const out = await h.call("add_pot_planned_draw", {
      operationId: next(),
      pot: "AOC",
      name: "Air tickets",
      amount: 1200,
      date: "2026-12-15",
    })
    // 300 now, 500 on 1 Dec, then 1,200 out
    expect(out.ledger.nextDraw).toMatchObject({
      name: "Air tickets",
      balanceAfter: -400,
    })
    expect(out.ledger.warnings.join(" ")).toMatch(
      /won't cover its next planned draw, Air tickets on 2026-12-15: \$400.00 short/
    )
  })
})

describe("the schedule", () => {
  test("changing a fund's amount keeps the contributions already made", async () => {
    const h = setup()
    await aocPool(h, {
      amount: 1000,
      fromAccountId: ACCOUNTS.joint.id,
      startDate: "2026-09-01",
    })
    const changed = await aocPool(h, {
      amount: 1200,
      fromAccountId: ACCOUNTS.joint.id,
    })
    expect(changed.frozenContributions).toBe(3)
    expect(changed.changed.pot.after.scheduledFrom).toBe("2026-11-15")
    const l = await h.call("get_pot_ledger", { pot: "AOC" })
    expect(l.contributed).toBe(3000)
    expect(l.lines.every((x: { kind: string }) => x.kind === "scheduled")).toBe(
      true
    )
    // the cap and end date carry over when not passed
    expect(changed.changed.pot.after).toMatchObject({
      capAmount: 7500,
      endDate: "2027-04-30",
    })
  })

  test("a skip adjustment on the fund's set-aside skips that contribution", async () => {
    const h = setup()
    await aocPool(h, {
      amount: 1000,
      fromAccountId: ACCOUNTS.joint.id,
      startDate: "2026-09-01",
    })
    await h.call("add_plan_adjustment", {
      operationId: next(),
      date: "2026-11-01",
      kind: "skip",
      target: "pot",
      name: "AOC",
    })
    const l = await h.call("get_pot_ledger", { pot: "AOC" })
    expect(l.contributed).toBe(2000)
  })

  test("contributions stop after the end date, in the ledger and the simulation", async () => {
    const h = setup()
    await aocPool(h, {
      amount: 1000,
      fromAccountId: ACCOUNTS.joint.id,
      endDate: "2026-12-15",
    })
    const live = (await livePlan(h.deps))!
    const sim = simulate(live.snapshot, live.plan)
    const setAsides = sim.events
      .filter((e) => e.kind === "set-aside" && e.pot === "AOC")
      .map((e) => e.date)
    // 1 Nov is in the fund's balance already (it started today, so it never had it)
    expect(setAsides).toEqual(["2026-12-01"])
  })
})

describe("yearly reset", () => {
  async function yearly(resetMode: "carry" | "release") {
    const h = setup("2026-11-14", [
      {
        id: 1,
        date: "2026-03-15",
        description: "PASSPORT",
        amount: -300,
        accountId: 1,
        category: "Travel",
      },
      {
        id: 2,
        date: "2026-06-15",
        description: "FLIGHTS",
        amount: -250,
        accountId: 1,
        category: "Travel",
      },
    ])
    await aocPool(h, {
      name: "Travel",
      cap: 1000,
      endDate: null,
      resetDate: "2026-04-01",
      resetMode,
    })
    await h.call("add_pot_contribution", {
      operationId: next(),
      pot: "Travel",
      amount: 1000,
      date: "2026-03-01",
    })
    await h.call("add_pot_contribution", {
      operationId: next(),
      pot: "Travel",
      amount: 200,
      date: "2026-05-01",
    })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "Travel",
      transactionId: 1,
    })
    await h.call("link_transaction_to_pot", {
      operationId: next(),
      pot: "Travel",
      transactionId: 2,
    })
    return h.call("get_pot_ledger", { pot: "Travel" })
  }

  test("carries the balance over and starts the cap again", async () => {
    const l = await yearly("carry")
    expect(l.cycle).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
      nextReset: "2027-04-01",
    })
    expect(l).toMatchObject({
      carriedIn: 700,
      contributed: 200,
      spent: 250,
      balance: 650,
    })
    expect(l.cap).toMatchObject({ used: 250, remaining: 750 })
  })

  test("or releases what's left", async () => {
    const l = await yearly("release")
    expect(
      l.lines.find((x: { kind: string }) => x.kind === "reset")
    ).toMatchObject({ date: "2026-04-01", amount: -700, balance: 0 })
    expect(l).toMatchObject({
      carriedIn: 0,
      contributed: 200,
      spent: 250,
      balance: -50,
    })
  })

  test("the cycle around a reset date", () => {
    expect(
      currentCycle({ resetDate: "2025-07-01", endDate: null }, "2026-06-30")
    ).toEqual({
      start: "2025-07-01",
      end: "2026-06-30",
      nextReset: "2026-07-01",
    })
    expect(
      currentCycle({ resetDate: "2025-07-01", endDate: null }, "2026-07-01")
        .start
    ).toBe("2026-07-01")
  })
})

describe("the plan and check_purchase", () => {
  test("the simulation pays planned draws from the fund, starting from its balance", async () => {
    const h = setup()
    await aocPool(h, { amount: 1500, fromAccountId: ACCOUNTS.joint.id })
    await h.call("add_pot_contribution", {
      operationId: next(),
      pot: "AOC",
      amount: 2000,
      date: "2026-11-10",
    })
    await h.call("add_pot_planned_draw", {
      operationId: next(),
      pot: "AOC",
      name: "Invoice",
      amount: 1800,
      date: "2026-11-20",
    })
    const live = (await livePlan(h.deps))!
    expect(live.snapshot.potFunds).toEqual([
      expect.objectContaining({
        pot: "AOC",
        balance: 2000,
        until: "2027-04-30",
        draws: [expect.objectContaining({ amount: 1800 })],
      }),
    ])
    const sim = simulate(live.snapshot, live.plan)
    const draw = sim.events.find((e) => e.name === "AOC: Invoice")!
    expect(draw).toMatchObject({
      kind: "bill",
      pot: "AOC",
      amount: 1800,
      accountId: ACCOUNTS.joint.id,
      oneOff: true,
    })
    // the fund starts at 2,000 and never runs dry, so it needs no seed
    expect(sim.potSummaries.find((p) => p.name === "AOC")).toMatchObject({
      seed: 0,
    })
    expect(sim.pots.AOC[sim.days.indexOf("2026-11-20")]).toBe(200)
  })

  test("tests a purchase against a fund's cap and balance", async () => {
    const h = setup()
    await aocPool(h, { amount: 1500, fromAccountId: ACCOUNTS.joint.id })
    await h.call("add_pot_contribution", {
      operationId: next(),
      pot: "AOC",
      amount: 2000,
      date: "2026-11-10",
    })
    const ok = await h.call("check_purchase", {
      name: "Invoice",
      amount: 1500,
      pot: "AOC",
    })
    expect(ok.verdict).toBe("yes")
    expect(ok.pot).toMatchObject({
      pot: "AOC",
      fits: true,
      balanceBefore: 2000,
      capRemainingAfter: 6000,
    })
    // no category line: the fund pays it
    expect(ok.budget).toBeNull()

    const over = await h.call("check_purchase", {
      name: "Everything",
      amount: 8000,
      pot: "AOC",
    })
    expect(over.pot).toMatchObject({ fits: false, overCap: true })
    expect(["over_pot", "wait", "no"]).toContain(over.verdict)
  })

  test("try_plan_change can try a fund without saving it", async () => {
    const h = setup()
    const out = await h.call("try_plan_change", {
      pots: [
        {
          name: "AOC",
          type: "sinking_fund",
          amount: 1500,
          frequency: "monthly",
          fromAccountId: ACCOUNTS.joint.id,
          cap: 7500,
        },
      ],
    })
    expect(out.diff.pots.added).toEqual([
      expect.objectContaining({ pot: "AOC" }),
    ])
    expect(h.pots).toHaveLength(0)
  })

  test("a set-aside can't take a cap, and needs an amount", async () => {
    const h = setup()
    await expect(
      h.call("upsert_pot", {
        operationId: next(),
        name: "Bills2",
        amount: 100,
        frequency: "monthly",
        fromAccountId: 2,
        cap: 100,
      })
    ).rejects.toThrow("pass type sinking_fund")
    await expect(
      h.call("upsert_pot", {
        operationId: next(),
        name: "Bills2",
        amount: 0,
        frequency: "monthly",
        fromAccountId: 2,
      })
    ).rejects.toThrow("above zero")
  })
})
