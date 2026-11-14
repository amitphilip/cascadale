import { describe, expect, test } from "vitest"

import { CHANGES_DATA, withMoney } from "@/lib/cas/tool"
import { getPlanState, livePlan } from "@/lib/plan-service"

import { ACCOUNTS, currentSnapshot } from "./fixtures/october-2026"
import { harness } from "./harness"

describe("tool definitions", () => {
  test("every write tool says it changes real data and takes an operation id", () => {
    const { tools } = harness()
    const writes = tools.filter((t) => t.access === "action")
    expect(writes.map((t) => t.name).sort()).toEqual([
      "add_plan_adjustment",
      "add_pot_contribution",
      "add_pot_planned_draw",
      "link_transaction_to_pot",
      "remove_plan_adjustment",
      "remove_pot",
      "remove_pot_planned_draw",
      "unlink_transaction_from_pot",
      "upsert_pot",
    ])
    for (const t of writes) {
      expect(t.description.startsWith(CHANGES_DATA)).toBe(true)
      expect(Object.keys(t.input)).toContain("operationId")
    }
  })

  test("responses carry the household's currency and locale", () => {
    const money = { currency: "NZD", locale: "en-NZ" }
    expect(withMoney({ a: 1 }, money)).toEqual({ currency: "NZD", locale: "en-NZ", a: 1 })
    expect(withMoney([1], money)).toEqual({ currency: "NZD", locale: "en-NZ", result: [1] })
  })
})

describe("get_plan", () => {
  test("returns the plan, its status and data_health", async () => {
    const h = harness()
    const out = await h.call("get_plan")
    expect(out.plan.set_asides.map((s: { pot: string }) => s.pot)).toEqual(["Visa", "Bills"])
    // made on Joint at 18,825; today's plan runs on 22,945, so it's never behind the data
    expect(out.status).toBe("current")
    expect(out.dataEnd).toBe(currentSnapshot().dataEnd)
    expect(out.data_health.drift[0]).toMatchObject({ account: "Everyday", difference: -150 })
  })

  test("no_plan before there is one", async () => {
    const out = await harness({ seedPlan: false }).call("get_plan")
    expect(out.status).toBe("no_plan")
    expect(out.plan).toBeNull()
  })
})

describe("upsert_pot", () => {
  test("puts a pot in the plan straight away", async () => {
    const h = harness()
    const out = await h.call("upsert_pot", {
      operationId: "op-1",
      reason: "Invest from Mary's pay",
      name: "Sharesies",
      amount: 650,
      frequency: "monthly",
      income: "Wood Partners",
      toAccountId: ACCOUNTS.sharesies.id,
    })
    expect(out.changed.pot.before).toBeNull()
    expect(out.changed.pot.after).toMatchObject({
      name: "Sharesies",
      amount: 650,
      frequency: "monthly",
      incomeName: "Wood Partners Consu WoodiPayroll41494-0579",
      toAccountId: ACCOUNTS.sharesies.id,
      updatedBy: "mcp",
      reason: "Invest from Mary's pay",
    })
    expect(out.change).toMatchObject({ actor: "mcp", reason: "Invest from Mary's pay" })
    expect(out.replayed).toBe(false)

    // the same service the Plan page renders from
    const page = await getPlanState({ repo: h.repo })
    expect(page.pots.map((p) => p.name)).toEqual(["Sharesies"])
    expect(page.status).toBe("current")
    expect(page.recentChanges).toEqual([
      expect.objectContaining({ actor: "mcp", action: "upsert_pot", summary: "Added pot Sharesies: 650 monthly" }),
    ])
    expect(out.planNow.monthly).toBeDefined()
    const live = await livePlan(h.deps)
    expect(live?.plan.set_asides.map((s) => s.pot)).toEqual(["Visa", "Bills", "Sharesies"])
  })

  test("is idempotent on the operation id", async () => {
    const h = harness()
    const args = { operationId: "same", name: "Sharesies", amount: 650, frequency: "monthly", income: "Wood Partners" }
    const first = await h.call("upsert_pot", args)
    const again = await h.call("upsert_pot", { ...args, amount: 999 })
    expect(again.replayed).toBe(true)
    expect(again.changed).toEqual(first.changed)
    expect(h.pots).toHaveLength(1)
    expect(h.pots[0].amount).toBe(650)
    expect(h.changes).toHaveLength(1)
    await expect(h.call("remove_pot", { operationId: "same", name: "Sharesies" })).rejects.toThrow(
      "already used for upsert_pot"
    )
  })

  test("changing a pot returns before and after", async () => {
    const h = harness()
    await h.call("upsert_pot", { operationId: "a", name: "Sharesies", amount: 650, frequency: "monthly", income: "Wood Partners" })
    const out = await h.call("upsert_pot", { operationId: "b", name: "sharesies", amount: 700, frequency: "monthly", income: "Wood Partners" })
    expect(out.changed.pot.before.amount).toBe(650)
    expect(out.changed.pot.after.amount).toBe(700)
    expect(h.pots).toHaveLength(1)
  })

  test("asks for an income it can't place, listing the keys, and leaves the operation id reusable", async () => {
    const h = harness()
    await expect(
      h.call("upsert_pot", { operationId: "x", name: "Sharesies", amount: 650, frequency: "monthly", income: "Mary" })
    ).rejects.toThrow(/No income match "Mary". Pass one of these keys: .*key 1:in:r11/)
    expect(h.changes).toHaveLength(0)
    const ok = await h.call("upsert_pot", { operationId: "x", name: "Sharesies", amount: 650, frequency: "monthly", income: "1:in:r11" })
    expect(ok.replayed).toBe(false)
  })
})

describe("remove_pot", () => {
  test("takes a pot the planner made out of the plan", async () => {
    const h = harness()
    const out = await h.call("remove_pot", { operationId: "r", name: "Visa", reason: "Card is closed" })
    expect(out.changed.pot.before).toMatchObject({ pot: "Visa", amount: 600 })
    expect(out.changed.pot.after).toBeNull()
    expect((await h.call("get_plan")).plan.set_asides.map((s: { pot: string }) => s.pot)).toEqual(["Bills"])
    expect(h.plans).toHaveLength(1)
  })

  test("errors on a pot that doesn't exist", async () => {
    await expect(harness().call("remove_pot", { operationId: "r", name: "Holiday" })).rejects.toThrow(
      'No pot named "Holiday". Pots: Visa, Bills'
    )
  })
})

describe("add_plan_adjustment, list_plan_adjustments and remove_plan_adjustment", () => {
  test("adds, lists and removes one-off adjustments", async () => {
    const h = harness()
    const skip = await h.call("add_plan_adjustment", {
      operationId: "s",
      date: "2026-11-11",
      kind: "skip",
      target: "pot",
      name: "visa",
    })
    expect(skip.changed.adjustment.after).toMatchObject({ kind: "skip", target: "pot", ref: "Visa", createdBy: "mcp" })
    const change = await h.call("add_plan_adjustment", {
      operationId: "c",
      date: "2026-11-20",
      kind: "change_amount",
      target: "bill",
      name: "Mercury",
      amount: 260,
    })
    expect(change.changed.adjustment.after).toMatchObject({ ref: "2:out:r15", name: "MERCURY ENERGY 123456" })

    const listed = await h.call("list_plan_adjustments")
    expect(listed.adjustments.map((a: { name: string }) => a.name)).toEqual(["Visa", "MERCURY ENERGY 123456"])

    const removed = await h.call("remove_plan_adjustment", { operationId: "d", adjustmentId: skip.changed.adjustment.after.id })
    expect(removed.changed.adjustment.before.id).toBe(skip.changed.adjustment.after.id)
    expect((await h.call("list_plan_adjustments")).adjustments).toHaveLength(1)
    await expect(
      h.call("remove_plan_adjustment", { operationId: "e", adjustmentId: skip.changed.adjustment.after.id })
    ).rejects.toThrow("No adjustment")
  })

  test("validates what it's given", async () => {
    const h = harness()
    const base = { date: "2026-11-11" }
    await expect(h.call("add_plan_adjustment", { ...base, operationId: "1", kind: "skip", target: "pot", name: "Visa", amount: 5 })).rejects.toThrow("A skip has no amount")
    await expect(h.call("add_plan_adjustment", { ...base, operationId: "2", kind: "add", target: "transfer", amount: 5, fromAccountId: 3 })).rejects.toThrow("two different accounts")
    await expect(h.call("add_plan_adjustment", { ...base, operationId: "3", kind: "skip", target: "bill", name: "Netflix" })).rejects.toThrow('No single bill matches "Netflix"')
    await expect(h.call("add_plan_adjustment", { operationId: "4", date: "2026-10-01", kind: "skip", target: "pot", name: "Visa" })).rejects.toThrow("The plan starts on 2026-10-28")
    await expect(h.call("add_plan_adjustment", { ...base, operationId: "5", kind: "add", target: "transfer", amount: 5, fromAccountId: 3, toAccountId: 99 })).rejects.toThrow("no account 99")
    expect(h.adjustments).toHaveLength(0)
  })
})

describe("the plan as it stands", () => {
  test("drops a set-aside whose income has gone, says so, and saves nothing", async () => {
    const h = harness({
      snapshot: () => {
        const snap = currentSnapshot()
        return {
          ...snap,
          incomes: snap.incomes.map((i) => ({ ...i, key: `new-${i.id}`, name: `Renamed ${i.id}` })),
        }
      },
    })
    const out = await h.call("get_plan")
    expect(out.plan.warnings.join(" ")).toContain("Dropped set-asides whose income stopped")
    // the stored plan still has them, so they return with the income
    expect(h.plans[0].plan.set_asides).toHaveLength(2)
  })

  test("says when a bill a pot covered has gone", async () => {
    const h = harness()
    const covered = h.plans[0].snapshot.bills.find((b) =>
      h.plans[0].plan.set_asides.some((s) => s.covers.includes(b.id))
    )!
    const h2 = harness({
      snapshot: () => {
        const snap = currentSnapshot()
        return { ...snap, bills: snap.bills.filter((b) => b.key !== covered.key && b.name !== covered.name) }
      },
    })
    const out = await h2.call("get_plan")
    expect(out.plan.warnings.join(" ")).toContain("Pots no longer cover these bills")
  })
})

describe("try_plan_change", () => {
  test("shows a change's effect and saves nothing", async () => {
    const h = harness()
    const out = await h.call("try_plan_change", {
      pots: [{ name: "Sharesies", amount: 650, frequency: "monthly", income: "Wood Partners" }],
      removePots: ["visa"],
    })
    expect(out.diff.pots.added).toEqual([{ pot: "Sharesies", monthly: 650 }])
    expect(out.diff.pots.removed).toEqual([expect.objectContaining({ pot: "Visa" })])
    expect(h.pots).toHaveLength(0)
    expect(h.changes).toHaveLength(0)
  })

  test("runs a skipped set-aside and a dearer bill through the simulation", async () => {
    const h = harness()
    const bill = h.plans[0].snapshot.bills[0]
    const out = await h.call("try_plan_change", {
      bills: [{ name: bill.key!, amount: bill.amount * 2 }],
      adjustments: [{ date: "2026-11-11", kind: "skip", target: "pot", name: "Visa" }],
    })
    expect(out.diff.monthly.after.bills).toBeGreaterThan(out.diff.monthly.before.bills)
    expect(out.diff.adjustments.added).toEqual([expect.stringContaining("skip Visa")])
    expect(out.end.after.date).toBe(out.end.before.date)
    expect(h.adjustments).toHaveLength(0)
  })

  test("rejects what a real change would reject", async () => {
    await expect(harness().call("try_plan_change", { removePots: ["Holiday"] })).rejects.toThrow('No pot named "Holiday"')
  })
})

describe("Cas decisions", () => {
  test("wait on the plan until a change carries them out", async () => {
    const h = harness({ decisions: ["Make Sharesies a deliberate pot: 650 a month from Mary's pay"] })
    const before = await h.call("get_plan")
    expect(before.unappliedDecisions).toEqual([expect.objectContaining({ content: expect.stringContaining("Sharesies") })])

    const out = await h.call("upsert_pot", {
      operationId: "p",
      name: "Sharesies",
      amount: 650,
      frequency: "monthly",
      income: "Wood Partners",
      decisionIds: [before.unappliedDecisions[0].id],
    })
    expect(out.appliedDecisions).toHaveLength(1)
    const after = await getPlanState({ repo: h.repo })
    expect(after.unappliedDecisions).toEqual([])
  })
})
