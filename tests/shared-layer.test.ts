import { describe, expect, test } from "vitest"

import { actionStatus } from "@/lib/plan-figures"

import { harness } from "./harness"

describe("plan figures", () => {
  test("get_plan reports the goal's gap, the low point and drift", async () => {
    const h = harness()
    const { figures } = await h.call("get_plan")
    expect(figures.goal.gap).toBeTypeOf("number")
    expect(figures.lowPoint).toMatchObject({ date: expect.any(String), amount: expect.any(Number) })
    expect(figures.drift[0]).toMatchObject({ account: "Everyday", difference: -150 })
    expect(["on_track", "watch", "off_track"]).toContain(figures.status)
  })

  test("action status is from the due date against today", () => {
    expect(actionStatus("2026-10-27", "2026-10-28")).toBe("overdue")
    expect(actionStatus("2026-11-01", "2026-10-28")).toBe("due_soon")
    expect(actionStatus("2026-12-01", "2026-10-28")).toBe("later")
    expect(actionStatus(null, "2026-10-28")).toBe("no_due_date")
  })
})

describe("plan action writes", () => {
  test("go through the change log, idempotent on operationId", async () => {
    const h = harness()
    const first = await h.call("add_plan_action", { operationId: "op-1", title: "Move 500 to Tax", reason: "IRD due" })
    const again = await h.call("add_plan_action", { operationId: "op-1", title: "Move 500 to Tax" })
    expect(again.id).toBe(first.id)
    expect(h.actions).toHaveLength(1)
    expect(h.changes).toHaveLength(1)
    expect(h.changes[0]).toMatchObject({ actor: "mcp", action: "add_plan_action", reason: "IRD due" })

    await h.call("set_plan_action_done", { operationId: "op-2", actionId: first.id, done: true })
    await h.call("set_plan_action_done", { operationId: "op-2", actionId: first.id, done: true })
    expect(h.changes.map((c) => c.action)).toEqual(["add_plan_action", "set_plan_action_done"])
    expect(h.actions[0].doneAt).not.toBeNull()
  })

  test("an open title returns the existing item, and an id is made up when missing", async () => {
    const h = harness()
    const a = await h.call("add_plan_action", { title: "Top up Joint" })
    const b = await h.call("add_plan_action", { title: "top up joint" })
    expect(b).toMatchObject({ ok: true, id: a.id, existing: true })
    expect(h.changes).toHaveLength(1)
  })
})
