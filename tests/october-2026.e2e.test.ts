import { describe, expect, test } from "vitest"

import { simulate } from "@/lib/plan"
import { getPlanState } from "@/lib/plan-service"

import { ACCOUNTS, LOAN_REPAYMENT, MARY_PAY } from "./fixtures/october-2026"
import { harness } from "./harness"

// The conversation from October 2026, end to end through the MCP tools: make Sharesies a
// deliberate pot, skip the Visa set-aside on the 11 Nov payday and send an extra 943 from
// Streamline to Joint that day, then rebuild. The website reads the result through the
// same service.

describe("October 2026, through MCP", () => {
  test("applies the Sharesies pot and both 11 Nov adjustments and rebuilds the plan", async () => {
    const h = harness()

    await h.call("upsert_pot", {
      operationId: "oct-sharesies",
      reason: "Make Sharesies a deliberate pot",
      name: "Sharesies",
      amount: 650,
      frequency: "monthly",
      income: "Wood Partners",
      toAccountId: ACCOUNTS.sharesies.id,
    })
    await h.call("add_plan_adjustment", {
      operationId: "oct-skip-visa",
      reason: "Card paid off early",
      date: "2026-11-11",
      kind: "skip",
      target: "pot",
      name: "Visa",
    })
    await h.call("add_plan_adjustment", {
      operationId: "oct-extra-joint",
      reason: "Top up Joint",
      date: "2026-11-11",
      kind: "add",
      target: "transfer",
      amount: 943,
      fromAccountId: ACCOUNTS.streamline.id,
      toAccountId: ACCOUNTS.joint.id,
    })

    const stale = await h.call("get_plan")
    expect(stale.status).toBe("out_of_date")
    expect(stale.reasons).toContain("3 plan changes not applied")

    const out = await h.call("regenerate_plan", {
      operationId: "oct-rebuild",
      reason: "Apply the October decisions",
      expectedPlanId: stale.planId,
    })

    // the plan includes the pot…
    const sharesies = out.plan.set_asides.find((s: { pot: string }) => s.pot === "Sharesies")
    expect(sharesies).toMatchObject({
      income_id: "MONTHLY",
      from_account_id: ACCOUNTS.joint.id,
      to_account_id: ACCOUNTS.sharesies.id,
      amount: 650,
    })
    expect(out.diff.pots.added).toEqual([{ pot: "Sharesies", monthly: 650 }])
    // …and both adjustments, as the simulation runs them on 11 Nov
    expect(out.adjustments.map((a: { kind: string; name: string }) => `${a.kind} ${a.name}`)).toEqual([
      "skip Visa",
      "add Transfer Streamline to Joint",
    ])
    const plan = (await h.repo.latestPlan())!
    const sim = simulate(plan.snapshot, plan.plan)
    const nov11 = sim.events.filter((e) => e.date === "2026-11-11")
    expect(nov11.some((e) => e.pot === "Visa")).toBe(false)
    expect(nov11).toContainEqual(
      expect.objectContaining({
        kind: "set-aside",
        amount: 943,
        fromAccountId: ACCOUNTS.streamline.id,
        accountId: ACCOUNTS.joint.id,
        pot: null,
      })
    )
    // the Visa set-aside still runs on the other paydays
    expect(sim.events.some((e) => e.pot === "Visa" && e.date === "2026-11-25")).toBe(true)

    // Mary's pay is one fortnightly salary across both bank descriptions
    const pay = plan.snapshot.incomes.filter((i) => i.name.includes("Wood Partners"))
    expect(pay).toHaveLength(1)
    expect(pay[0]).toMatchObject({ cadence: "fortnightly", amount: MARY_PAY, nextDate: "2026-10-28" })
    expect(sim.events.filter((e) => e.kind === "income" && e.ref === pay[0].id).map((e) => e.date)).toContain("2026-11-11")

    // the Joint home loan repayment is a bill, about 3,938 a month
    const loan = plan.snapshot.bills.find((b) => b.category === "Loan repayments")
    expect(loan).toMatchObject({ accountId: ACCOUNTS.joint.id, cadence: "fortnightly", amount: LOAN_REPAYMENT })
    expect(loan!.monthly).toBeGreaterThan(3900)
    expect(loan!.monthly).toBeLessThan(4000)

    // amounts are NZD
    expect(plan.snapshot.currency).toBe("NZD")

    // data_health reports the Everyday drift, and the plan is now built on today's balances
    const after = await h.call("get_plan")
    expect(after.data_health.drift).toEqual([
      { account: "Everyday", cascadale: 1082.5, bank: 1232.5, difference: -150, explainedByPending: false },
    ])
    expect(after.data_health.plan.movedMaterially).toBe(false)
    expect(after.status).toBe("current")

    // the website shows it, with who made each change
    const page = await getPlanState({ repo: h.repo })
    expect(page.plan?.id).toBe(out.planId)
    expect(page.pots.map((p) => `${p.name} by ${p.updatedBy}`)).toEqual(["Sharesies by mcp"])
    expect(page.adjustments.map((a) => `${a.date} ${a.kind} by ${a.createdBy}: ${a.reason}`)).toEqual([
      "2026-11-11 skip by mcp: Card paid off early",
      "2026-11-11 add by mcp: Top up Joint",
    ])
    expect(page.recentChanges.map((c) => c.action)).toEqual([
      "regenerate_plan",
      "add_plan_adjustment",
      "add_plan_adjustment",
      "upsert_pot",
    ])

    // retrying the rebuild changes nothing
    const again = await h.call("regenerate_plan", { operationId: "oct-rebuild" })
    expect(again.replayed).toBe(true)
    expect(h.plans).toHaveLength(2)
  })
})
