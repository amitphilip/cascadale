import "server-only"

import { getDb, must } from "@/lib/db"
import { setShortTerm } from "@/lib/planning/short-term"
import {
  cycleModel,
  loadCardPositions,
  loadMemberPosition,
  memberBuffers,
  memberGoals,
  whatIfContext,
} from "@/lib/planning/data"
import { logChange, proposeUpsert } from "@/lib/planning/plan-edit"
import { parseWhatIfId, whatIf, type WhatIfRequest } from "@/lib/planning/what-if"

// what_if and commit_purchase: a purchase weighed against a member's real numbers, then,
// once they say yes, recorded as a one-off with the option they chose applied. An option
// that only touches this pay changes their short-term allocation straight away; one that
// changes the long-term plan becomes a pending change for a member to approve.

/** Work out a purchase. Reads only. */
export async function runWhatIf(request: Omit<WhatIfRequest, "memberId"> & { memberId?: string | null }) {
  const p = await loadMemberPosition(request.memberId)
  const r: WhatIfRequest = {
    memberId: p.member.id,
    amount: Math.round(request.amount * 100) / 100,
    date: request.date,
    accountId: request.accountId ?? null,
    description: request.description.trim(),
    spreadOver: request.spreadOver ?? null,
  }
  if (r.accountId !== null && !p.accounts.some((a) => a.id === r.accountId)) {
    throw new Error(`Account ${r.accountId} isn't one of the household's`)
  }
  const [model, cards] = await Promise.all([
    cycleModel(p),
    loadCardPositions(3, { payments: p.payments, accounts: p.accounts, txs: p.txs }),
  ])
  // the card they'd use: the one named, else the one their accounts pay off
  const card =
    cards.find((c) => c.accountId === r.accountId) ??
    cards.find((c) => c.usualPayments.some((u) => p.accounts.some((a) => a.name === u.from && a.holderId === p.member.id))) ??
    cards[0] ??
    null
  const result = whatIf({
    today: p.today,
    request: r,
    position: p.position,
    future: model.model,
    payEvery: model.payEvery,
    balances: p.balances,
    accountName: p.accountName,
    mine: p.mineSet,
    goals: memberGoals(p),
    buffers: memberBuffers(p),
    card,
    oneOffAccountId: r.accountId !== null && r.accountId !== card?.accountId ? r.accountId : null,
  })
  const context = await whatIfContext(p, model)
  return {
    ...result,
    member: p.member.name,
    context: {
      ...context,
      creditCard: card && {
        ...card,
        carriesBalanceIfOnCard: result.options.find((o) => o.id === "card")?.carriesCardBalance ?? null,
      },
      cycleModel: {
        ...model.model,
        payEvery: model.payEvery,
        lastCycles: model.lastCycles,
        spentThisCycleSoFar: model.spentThisCycleSoFar,
        note: "A typical cycle ahead: income is their regular pays, moves the plan's moves from their accounts, bills their recurring payments no move covers, spending what they spent in each of the last three cycles on average.",
      },
      position: {
        cycle: p.position.cycle,
        pay: p.position.pay,
        payAccount: p.position.payAccount,
        movesLeft: p.position.movesLeft,
        billsDue: p.position.billsDue,
        paysDue: p.position.paysDue,
        uncovered: p.position.uncovered,
      },
    },
  }
}

/**
 * Record a purchase as a one-off and apply the option chosen. `askedBy` is the member who
 * said yes (the what_if's member).
 */
export async function commitPurchase(id: string, option: string, reason: string) {
  const r = parseWhatIfId(id)
  const result = await runWhatIf(r)
  const chosen = result.options.find((o) => o.id === option)
  if (!chosen) {
    throw new Error(`No option "${option}" for this purchase now. The options are: ${result.options.map((o) => o.id).join(", ")}`)
  }
  if (!chosen.feasible) throw new Error(`"${option}" no longer works with today's numbers: run what_if again`)
  const why = reason.trim() || `${r.description}: ${chosen.label}`
  const who = { askedBy: r.memberId, madeBy: "claude" as const, reason: why }
  const p = await loadMemberPosition(r.memberId)

  // the purchase, as a one-off: where its money is and when it's paid
  const useBuffer = chosen.id === "use_buffer" ? chosen.shortTerm[0]?.fromAccountId : undefined
  const accountId =
    (chosen.id.startsWith("spread_over_") ? chosen.plan[0]?.toAccountId : null) ??
    useBuffer ??
    (r.accountId !== null && p.accounts.find((a) => a.id === r.accountId)?.type !== "credit_card" ? r.accountId : null) ??
    p.position.payAccount?.id
  if (!accountId) throw new Error("There's no account to record the purchase against")
  const saving = chosen.id.startsWith("spread_over_") || chosen.id === "wait_until_next_pay"
  const oneOff = await must<{ id: number }>(
    (await getDb())
      .from("one_offs")
      .insert({
        name: r.description.slice(0, 80),
        total: r.amount,
        account_id: accountId,
        start_date: p.today,
        finish_date: chosen.payDate < p.today ? p.today : chosen.payDate,
        out_mode: "single",
        out_every: null,
        in_every: p.basis.args.cycle.pay?.every ?? "month",
        // paid now from money that's there; saved up for when it waits or is spread
        set_aside: saving ? 0 : r.amount,
        note: `${chosen.label}. ${why}`.slice(0, 500),
      })
      .select("id")
      .single()
  )

  // this pay's lines, straight away
  let shortTerm = null
  if (chosen.shortTerm.length) {
    const kept = p.lines.filter(
      (l) => !chosen.shortTerm.some((c) => c.planItemId !== null && c.planItemId === l.planItemId)
    )
    const lines = [
      ...kept.map((l) => ({
        planItemId: l.planItemId,
        title: l.title,
        fromAccountId: l.fromAccountId,
        toAccountId: l.toAccountId,
        match: l.match,
        amount: l.amount,
        dueDate: l.dueDate,
        reason: l.reason,
      })),
      ...chosen.shortTerm.map((c) => ({
        planItemId: c.planItemId,
        title: c.title,
        fromAccountId: c.fromAccountId,
        toAccountId: c.toAccountId,
        match: null,
        amount: c.amount,
        dueDate: null,
        reason: c.reason,
      })),
    ]
    const { before, shortTerm: saved } = await setShortTerm(lines, undefined, { memberId: r.memberId, by: "claude" })
    await logChange({ entity: "short_term", entityId: saved.id, action: "set", who, before: before?.lines ?? null, after: saved.lines })
    shortTerm = saved
  }

  // the long-term plan, as pending changes
  const pending = []
  for (const c of chosen.plan) {
    const { pending: row } = await proposeUpsert(
      {
        title: c.title,
        purpose: c.purpose,
        fromAccountId: c.fromAccountId,
        toAccountId: c.toAccountId,
        amount: c.amount,
        every: c.every,
        startDate: c.startDate,
        endDate: c.endDate,
        notes: c.notes,
        oneOffId: oneOff.id,
        target: r.amount,
      },
      who,
      { purchase: id }
    )
    pending.push(row)
  }

  await logChange({
    entity: "purchase",
    entityId: oneOff.id,
    action: "commit",
    who,
    before: null,
    after: { request: r, option: chosen.id, label: chosen.label, changes: chosen.changes, oneOffId: oneOff.id, pendingChangeIds: pending.map((x) => x.id) },
  })

  return {
    committed: { oneOffId: oneOff.id, description: r.description, amount: r.amount, option: chosen.id, label: chosen.label },
    shortTerm: shortTerm && { lines: shortTerm.lines, updatedAt: shortTerm.updatedAt },
    pendingChanges: pending,
    manualSteps: chosen.notes.filter((n) => /by hand/i.test(n)),
    next:
      pending.length > 0
        ? `The plan change waits for approval: ${pending.map((x) => `#${x.id} (${x.approvableBy.join(" or ")})`).join(", ")}.`
        : "Nothing waits for approval.",
  }
}
