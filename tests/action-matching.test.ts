import { describe, expect, test } from "vitest"

import { modelConfig } from "@/lib/cas/models"

import { matchActions, type MatchTx } from "@/lib/action-matching"
import type { PlanAction } from "@/lib/db/schema"
import { loadStatus } from "@/lib/cas/status"
import { runCas } from "@/lib/cas/worker"
import { buildDataHealth } from "@/lib/health"

import { ACCOUNTS, TODAY, healthInput } from "./fixtures/october-2026"
import { harness } from "./harness"
import { memoryCasStore } from "./memory-cas-store"

const action = (over: Partial<PlanAction>): PlanAction => ({
  id: 1,
  title: "Move 943 from Streamline to Joint",
  detail: null,
  dueDate: "2026-10-25",
  focusTitle: null,
  createdBy: "cas",
  doneAt: null,
  createdAt: "2026-10-20T01:00:00Z",
  amount: 943,
  fromAccountId: ACCOUNTS.streamline.id,
  toAccountId: ACCOUNTS.joint.id,
  ...over,
})
let txId = 100
const tx = (accountId: number, date: string, amount: number, description = "TRANSFER"): MatchTx => ({
  id: ++txId,
  accountId,
  date,
  amount,
  description,
})

describe("matching action items to transactions", () => {
  test("both sides of a transfer, to the cent and within a few days, is a confident match", () => {
    const out = tx(ACCOUNTS.streamline.id, "2026-10-26", -943)
    const into = tx(ACCOUNTS.joint.id, "2026-10-27", 943)
    expect(matchActions([action({})], [out, into, tx(ACCOUNTS.joint.id, "2026-10-27", 94.3)], TODAY)).toEqual([
      { actionId: 1, kind: "confident", transactionId: out.id, transactionIds: [out.id, into.id] },
    ])
  })

  test("two possible transfers, or only one side, is ambiguous", () => {
    const pairs = [
      tx(ACCOUNTS.streamline.id, "2026-10-21", -943),
      tx(ACCOUNTS.joint.id, "2026-10-21", 943),
      tx(ACCOUNTS.streamline.id, "2026-10-26", -943),
      tx(ACCOUNTS.joint.id, "2026-10-26", 943),
    ]
    expect(matchActions([action({})], pairs, TODAY)[0].kind).toBe("ambiguous")
    expect(matchActions([action({})], [pairs[0]], TODAY)[0].kind).toBe("ambiguous")
  })

  test("ignores items with no amount or account, other amounts, and transactions outside the window", () => {
    const far = tx(ACCOUNTS.streamline.id, "2026-09-01", -943)
    expect(matchActions([action({ amount: null })], [tx(ACCOUNTS.streamline.id, "2026-10-26", -943)], TODAY)).toEqual([])
    expect(matchActions([action({ toAccountId: null })], [far, tx(ACCOUNTS.streamline.id, "2026-10-26", -942)], TODAY)).toEqual([])
  })

  test("a transaction shows one item done, not two", () => {
    const out = tx(ACCOUNTS.streamline.id, "2026-10-26", -943)
    const matches = matchActions([action({ toAccountId: null }), action({ id: 2, toAccountId: null })], [out], TODAY)
    expect(matches.map((m) => m.actionId)).toEqual([1])
  })
})

describe("after a sync", () => {
  test("a transfer matching an open action ticks it off as system before the snapshot", async () => {
    const h = harness({ actions: [action({})] })
    const cas = memoryCasStore(h.changes)
    const txs = [tx(ACCOUNTS.streamline.id, "2026-10-26", -943), tx(ACCOUNTS.joint.id, "2026-10-26", 943)]
    const { snapshot, matched } = await runCas({
      plan: { ...h.deps, actor: "cas", onChange: undefined },
      system: { ...h.deps, actor: "system", onChange: undefined },
      transactions: async () => txs,
      store: cas.store,
      source: { ...h.ctx.figures, health: async () => buildDataHealth(healthInput()) },
      judge: null,
      models: modelConfig(new Map()),
      today: TODAY,
    })
    expect(matched.ticked).toEqual([1])
    expect(h.actions[0]).toMatchObject({ doneBy: "system", doneTransactionId: txs[0].id })
    expect(h.changes.at(-1)).toMatchObject({ actor: "system", action: "set_plan_action_done", transactionId: txs[0].id })
    // the snapshot reflects the tick: nothing overdue, and it's based on that change
    expect((snapshot.figures as { actions: unknown[] }).actions).toEqual([])
    expect(snapshot.basedOnChangeId).toBe(h.changes.at(-1)!.id)
    expect((await loadStatus(cas.store)).is_stale).toBe(false)
  })

  test("an ambiguous match becomes one proposal, not a tick", async () => {
    const h = harness({ actions: [action({ toAccountId: null })] })
    const cas = memoryCasStore(h.changes)
    const txs = [tx(ACCOUNTS.streamline.id, "2026-10-22", -943), tx(ACCOUNTS.streamline.id, "2026-10-26", -943)]
    const deps = {
      plan: { ...h.deps, actor: "cas" as const, onChange: undefined },
      system: { ...h.deps, actor: "system" as const, onChange: undefined },
      transactions: async () => txs,
      store: cas.store,
      source: { ...h.ctx.figures, health: async () => buildDataHealth(healthInput()) },
      judge: null,
      models: modelConfig(new Map()),
      today: TODAY,
    }
    await runCas(deps)
    await runCas(deps)
    expect(h.actions[0].doneAt).toBeNull()
    expect(cas.proposals).toHaveLength(1)
    expect(cas.proposals[0]).toMatchObject({ source: "system", tool: "set_plan_action_done", args: { actionId: 1, done: true } })
  })
})
