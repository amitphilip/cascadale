import { beforeEach, describe, expect, test, vi } from "vitest"

import { payerRules } from "@/lib/planning/plan-check"
import { whatIfId } from "@/lib/planning/what-if"
import { AMIT, CHECK, JOINT, SAVING, TODAY, goals, ipad, position } from "./fixtures/amit-cycle"
import { SCHOOL_FEES_NOTE } from "./fixtures/household-november"
import { fakeDb } from "./support/fake-db"

// Plan writes: a reason is required, a standing rule is enforced, and every long-term change
// (commit_purchase's included) waits as a pending change until a member approves it.

const MARY = "mary-id"
const MARY_ACCOUNT = 67
const members = [
  { id: AMIT, name: "Amit", isYou: false },
  { id: MARY, name: "Mary", isYou: false },
]
const state = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import("./support/fake-db").fakeDb>, you: "amit-id" }))
const setShortTerm = vi.hoisted(() => vi.fn())

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: async () => state.db.client,
  getUserId: async () => state.you,
}))
vi.mock("@/lib/queries", () => ({
  getPeople: async () => members.map((m) => ({ id: m.id, name: m.name, isOwner: m.id === AMIT })),
}))
vi.mock("@/lib/plan-data", () => ({
  getCurrentPlan: async () => ({ plan: { id: 5 }, allocations: [], actions: [] }),
}))
vi.mock("@/lib/planning/short-term", () => ({ setShortTerm }))
vi.mock("@/lib/planning/data", () => {
  const accounts = [
    { id: 1, name: "Check Account - Amit", type: "checking", balance: 2567.36, holderId: "amit-id", owner: "Amit", purpose: null, spendable: null, archived: false },
    { id: 34, name: "Check Account - Joint", type: "loan", balance: -20521.43, holderId: null, owner: "Joint", purpose: null, spendable: null, archived: false },
    { id: 102, name: "Everyday Saving", type: "checking", balance: 495, holderId: "amit-id", owner: "Amit", purpose: null, spendable: null, archived: false },
    { id: 67, name: "Check Account - Mary", type: "checking", balance: 489.38, holderId: "mary-id", owner: "Mary", purpose: null, spendable: null, archived: false },
  ]
  return {
    getMembers: async () => ({ members: members.map((m) => ({ ...m, isYou: m.id === state.you })), you: state.you }),
    resolveMember: async (id?: string) => members.find((m) => m.id === (id ?? state.you) || m.name === id)!,
    householdAccounts: async () => accounts,
    standingRules: async () => payerRules([SCHOOL_FEES_NOTE], members),
    loadMemberPosition: async () => ({
      member: members[0],
      today: TODAY,
      position: position(2567.36),
      mineSet: new Set([CHECK, SAVING]),
      balances: new Map([[CHECK, 2567.36]]),
      accountName: new Map([[CHECK, "Check Account - Amit"]]),
      accounts,
      payments: [],
      txs: [],
      lines: [],
      oneOffs: [],
      basis: { args: { cycle: { pay: { every: "fortnight" } } } },
    }),
    cycleModel: async () => ({
      model: { days: 14, income: 5122.36, moves: 3065, bills: 400, spending: 900 },
      payEvery: "fortnight",
      lastCycles: [],
      spentThisCycleSoFar: 0,
    }),
    loadCardPositions: async () => [],
    memberGoals: () => goals,
    memberBuffers: () => [],
    whatIfContext: async () => ({}),
  }
})

const { approveChange, proposeRemove, proposeUpsert, rejectChange } = await import("@/lib/planning/plan-edit")
const { commitPurchase, runWhatIf } = await import("@/lib/planning/purchase")

const amitAsks = (reason: string) => ({ askedBy: AMIT, madeBy: "claude" as const, reason })

beforeEach(() => {
  state.db = fakeDb({
    plan_items: [
      { id: 110, plan_id: 5, kind: "allocation", purpose: "bills", title: "Mortgage and school fees", amount: 2555, every: "fortnight", account_id: JOINT, from_account_id: CHECK, from_member_id: AMIT, match_keys: [], removed_at: null, position: 0 },
    ],
  })
  state.you = AMIT
  setShortTerm.mockReset()
})

const planItemWrites = () => state.db.writes.filter((w) => w.table === "plan_items")

describe("plan writes need a reason", () => {
  test("upsert_plan_item with no reason is rejected before anything is written", async () => {
    await expect(
      proposeUpsert({ title: "Daycare", purpose: "bills", fromAccountId: MARY_ACCOUNT, amount: 363.6, every: "week" }, amitAsks("  "))
    ).rejects.toThrow(/Give a reason/)
    expect(state.db.writes).toEqual([])
  })

  test("remove_plan_item and reject_change with no reason are rejected too", async () => {
    await expect(proposeRemove(110, amitAsks(""))).rejects.toThrow(/Give a reason/)
    await expect(rejectChange(1, AMIT, "", "claude")).rejects.toThrow(/Give a reason/)
    expect(state.db.writes).toEqual([])
  })
})

describe("standing rules", () => {
  test("school fees on Amit's pay break the rule that Mary pays them", async () => {
    await expect(
      proposeUpsert({ title: "School fees", purpose: "bills", fromAccountId: CHECK, toAccountId: JOINT, amount: 728, every: "fortnight" }, amitAsks("Cover the fees"))
    ).rejects.toThrow(/decision note 42 says Mary pays it/)
    expect(state.db.writes).toEqual([])
  })

  test("from Mary's account they're fine, and override lets a change of mind through", async () => {
    await expect(
      proposeUpsert({ title: "School fees", purpose: "bills", fromAccountId: MARY_ACCOUNT, toAccountId: JOINT, amount: 728, every: "fortnight" }, amitAsks("Mary's fees"))
    ).resolves.toBeTruthy()
    const { overriddenRules } = await proposeUpsert(
      { title: "School fees", purpose: "bills", fromAccountId: CHECK, toAccountId: JOINT, amount: 728, every: "fortnight" },
      amitAsks("Amit takes the fees over from January"),
      { override: true }
    )
    expect(overriddenRules).toHaveLength(1)
  })
})

describe("pending changes", () => {
  test("a proposal changes nothing in the plan until it's approved", async () => {
    // the item breaks the school fees rule as it stands, so an edit that keeps it is refused
    await expect(proposeUpsert({ id: 110, amount: 2020 }, amitAsks("Joint gets $2,020 a pay"))).rejects.toThrow(/Mary pays it/)
    const { pending } = await proposeUpsert(
      { id: 110, title: "Mortgage", amount: 2020 },
      amitAsks("Joint gets $2,020 a pay, as it actually does; Mary pays the school fees")
    )
    expect(pending).toMatchObject({ status: "pending", shared: true, kind: "upsert", planItemId: 110 })
    expect(planItemWrites()).toEqual([])
    expect(state.db.rows("plan_items")[0].amount).toBe(2555)

    await approveChange(pending.id, "Amit", "claude")
    expect(state.db.rows("plan_items")[0]).toMatchObject({ amount: 2020, title: "Mortgage" })
    const log = state.db.rows("plan_changes").map((c) => [c.entity, c.action, c.made_by])
    expect(log).toEqual([
      ["pending", "propose", "claude"],
      ["plan_item", "update", "claude"],
      ["pending", "approve", "claude"],
    ])
    expect(state.db.rows("plan_changes")[1]).toMatchObject({
      asked_by: AMIT,
      reason: "Joint gets $2,020 a pay, as it actually does; Mary pays the school fees",
      before: expect.objectContaining({ title: "Mortgage and school fees", amount: 2555 }),
      after: expect.objectContaining({ title: "Mortgage", amount: 2020 }),
    })
  })

  test("a member can only approve as themselves, and a personal item only its owner can", async () => {
    const { pending } = await proposeUpsert(
      { title: "Everyday Saving", purpose: "savings", fromAccountId: CHECK, toAccountId: SAVING, amount: 150, every: "fortnight" },
      amitAsks("Save a bit more")
    )
    expect(pending).toMatchObject({ shared: false, approverId: AMIT })
    // Claude, in Amit's session, approving for Mary
    await expect(approveChange(pending.id, "Mary", "claude")).rejects.toThrow(/signed in as Amit/)
    // Mary, in her own session, approving Amit's own item
    state.you = MARY
    await expect(approveChange(pending.id, "Mary", "claude")).rejects.toThrow(/only Amit can decide it/)
    expect(planItemWrites()).toEqual([])
    state.you = AMIT
    const { planItemId } = await approveChange(pending.id, AMIT, "claude")
    expect(state.db.rows("plan_items").find((r) => r.id === planItemId)).toMatchObject({ title: "Everyday Saving", amount: 150, from_member_id: AMIT, plan_id: 5 })
  })

  test("a shared item's change takes either member, and once decided it can't be decided again", async () => {
    const { pending } = await proposeRemove(110, amitAsks("The mortgage move is split by person now"))
    state.you = MARY
    await approveChange(pending.id, "Mary", "claude")
    expect(state.db.rows("plan_items")[0].removed_at).toBeTruthy()
    await expect(approveChange(pending.id, "Mary", "claude")).rejects.toThrow(/already approved/)
  })
})

describe("what_if and commit_purchase", () => {
  test("what_if for a $1,200 purchase on Amit's current cycle returns a verdict and saves nothing", async () => {
    const r = await runWhatIf(ipad)
    expect(["affordable", "affordable_with_changes", "not_affordable"]).toContain(r.verdict)
    expect(r.whatIfId).toBe(whatIfId(ipad))
    expect(state.db.writes).toEqual([])
    expect(setShortTerm).not.toHaveBeenCalled()
  })

  test("a long-term change from commit_purchase stays pending until a member approves it", async () => {
    const id = whatIfId(ipad)
    const out = await commitPurchase(id, "spread_over_3", "Amit said yes: spread the iPad over three pays")
    expect(out.committed).toMatchObject({ option: "spread_over_3", amount: 1200 })
    expect(out.pendingChanges).toHaveLength(1)
    expect(out.pendingChanges[0]).toMatchObject({ status: "pending", purchase: id })
    // the purchase is recorded, the plan isn't touched, this pay isn't touched
    expect(state.db.rows("one_offs")).toEqual([expect.objectContaining({ name: "iPad", total: 1200, set_aside: 0 })])
    expect(planItemWrites()).toEqual([])
    expect(setShortTerm).not.toHaveBeenCalled()

    await approveChange(out.pendingChanges[0].id, AMIT, "claude")
    expect(state.db.rows("plan_items").find((r) => r.title === "iPad")).toMatchObject({ amount: 400, every: "fortnight", purpose: "one_off" })
  })

  test("an option that only touches this pay changes the short-term allocation straight away", async () => {
    setShortTerm.mockResolvedValue({ before: null, shortTerm: { id: 9, lines: [], updatedAt: "now" } })
    const out = await commitPurchase(whatIfId(ipad), "pause_goal", "Hold back savings this pay")
    expect(setShortTerm).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ planItemId: 130, amount: 0 })]),
      undefined,
      { memberId: AMIT, by: "claude" }
    )
    expect(out.pendingChanges).toEqual([])
    expect(planItemWrites()).toEqual([])
  })

  test("an option that isn't on offer is refused", async () => {
    await expect(commitPurchase(whatIfId(ipad), "lottery", "why not")).rejects.toThrow(/No option "lottery"/)
  })
})
