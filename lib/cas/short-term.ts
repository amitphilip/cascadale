import "server-only"

import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"

import { anthropicClient, getApiKey } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import { getUserId } from "@/lib/db"
import { casEnabled } from "@/lib/flags"
import { loadAllocationBasis, type AllocationBasis } from "@/lib/month"
import { myAllocation } from "@/lib/my-allocation"
import { getCurrentPlan } from "@/lib/plan-data"
import { loadPlanInputs } from "@/lib/plan-inputs"
import { getAccountHolders, getOpenCasNotes, getSettings } from "@/lib/queries"
import { cleanLines, type ShortTermLine } from "@/lib/short-term"
import { getShortTerm, saveShortTerm, shortTermReady, type ShortTerm } from "@/lib/short-term-data"

// Cas's short-term allocation: the transfers for one person's pay this pay cycle, worked out
// from the plan (the long-term allocation) and what has actually happened since payday. One
// model call with a structured answer, made again whenever a sync brings in a pay or a move
// for that person's accounts (the fingerprint changes), or when someone asks in Claude.
// The figures come from lib/my-allocation.ts and lib/short-term.ts, never the model.

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 16000

const ShortTermSchema = z.object({
  summary: z
    .string()
    .describe("One or two plain sentences: what this pay does, and anything to act on, leading with the number"),
  lines: z
    .array(
      z.object({
        plan_item_id: z
          .number()
          .int()
          .nullable()
          .describe("The plan move (planMoves[].planItemId) this sets this pay's amount for; null for a move the plan doesn't name"),
        title: z.string().describe("At most 5 words, e.g. 'Pay off credit card'"),
        from_account_id: z.number().int().describe("One of yourAccounts"),
        to_account_id: z
          .number()
          .int()
          .nullable()
          .describe("Where it goes: a household account id; null when the money leaves the household"),
        match: z
          .string()
          .nullable()
          .describe("When to_account_id is null: the match of the move in movesSoFar it is; else null"),
        amount: z.number().nonnegative().describe("This pay's amount; 0 to skip a plan move this pay"),
        due_date: z.string().nullable().describe("yyyy-MM-dd it should go by, when not straight away; else null"),
        reason: z.string().describe("At most 15 words, the deciding number first"),
      })
    )
    .describe("This pay's transfers that differ from the plan or that the plan doesn't name"),
})

const SYSTEM = `You are Cas, the financial accountant and manager for one household, inside their private budgeting app. The plan is the household's long-term allocation: what each pay does, set now and then. Here you work out one person's short-term allocation: the actual transfers for their pay this pay cycle, "this much, from this account, to that one", from what has really happened since payday. You look again each time a bank sync brings in a pay or a move, so keep what still holds and change only what the new data changes.

The data (amounts in their currency):
- cycle: this pay cycle (start is payday, end the next one; late when the next pay is overdue). pay: what has landed and what's still due.
- yourAccounts: the person's accounts with balances; otherAccounts: the rest of the household's (joint, partner's, cards, loans).
- planMoves: each plan allocation leaving their accounts, with what the plan has for it this pay (plannedThisPay), what should have gone by now, and what has gone (doneSoFar; null when it can't be told).
- bills: plan bills paid from their accounts this pay. spending: their pay less the plan, against what they've spent (left is what's spare for spending).
- movesSoFar: every transfer out of their accounts this pay: to a household account (toAccountId), or out of the household (toAccountId null, with its match).
- oneOffs: known costs coming up, with what still needs to go in (toPutIn) and what's behind (needNow).
- previous: your last short-term allocation for this pay, if any. Lines by "you" were set by the person; keep them as they are unless they're done or plainly overtaken.
- notes: their decisions and preferences. Follow them.

The lines:
- A plan move that should be different this pay (more, less, or 0 to skip it) gets a line with its plan_item_id, the amount for this pay and why. Leave out plan moves that stand as planned.
- Every move in movesSoFar that no plan move covers gets a line of its own (plan_item_id null) at its exact amount, saying what it was for as best the data shows. Moves to the same place can share a line.
- Add the moves still to make this pay that the plan doesn't name: paying a card statement, topping up a one-off that's behind, then what's genuinely spare towards debt or savings as the plan's goals have it. Name the accounts.
- Never move money that isn't there. A pay still due counts only once it lands: while it's late, hold what depends on it (0, or a due_date after it's due) and say so. Leave the spending that's left, and a small buffer, in the account.
- Amounts: an already-made move at its exact amount; others tidy, whole dollars and to the nearest $5 above $100.
- Use ids only from the data. Refer to accounts by name in text, never by id.`

/** A household member (the signed-in person by default) and the accounts that are theirs. */
export async function myAccounts(memberId?: string) {
  const [id, holders] = await Promise.all([memberId ?? getUserId(), getAccountHolders()])
  return { memberId: id, mine: [...holders].filter(([, h]) => h === id).map(([a]) => a) }
}

/** What Cas reads to work out the short-term allocation. */
function casData(basis: AllocationBasis, saved: ShortTerm | null, currency: string) {
  const { args, plan, inputs } = basis
  const mine = new Set(args.mine)
  const planOnly = myAllocation(args)
  const current = saved ? myAllocation({ ...args, shortTerm: saved.lines }) : null
  const item = new Map(plan.allocations.map((a) => [a.id, a]))
  const name = (id: number | null) => (id === null ? null : (args.accountName.get(id) ?? null))
  return {
    today: args.today,
    currency,
    cycle: {
      start: args.cycle.start,
      end: args.cycle.end,
      late: planOnly.cycle.late,
      mainPay: args.cycle.pay,
    },
    pay: planOnly.pay,
    yourAccounts: inputs.accounts
      .filter((a) => mine.has(a.id))
      .map(({ id, name, type, balance, isDebt, interestRate }) => ({ id, name, type, balance, isDebt, interestRate })),
    otherAccounts: inputs.accounts
      .filter((a) => !mine.has(a.id))
      .map(({ id, name, type, balance, isDebt, interestRate, holder }) => ({ id, name, type, balance, isDebt, interestRate, holder })),
    planMoves: planOnly.moves.map((m) => ({
      planItemId: m.id,
      title: m.title,
      purpose: m.purpose,
      detail: item.get(m.id)?.detail ?? null,
      fromAccountId: item.get(m.id)?.fromAccountId ?? null,
      toAccountId: item.get(m.id)?.accountId ?? null,
      to: m.to,
      amount: m.amount,
      every: m.every,
      plannedThisPay: m.planned,
      dueByNow: m.byNow,
      doneSoFar: m.done,
      status: m.status,
    })),
    bills: planOnly.bills.map((b) => ({ title: b.title, plannedThisPay: b.planned, paidSoFar: b.done })),
    spending: planOnly.spending,
    movesSoFar: basis.moves.map((m) => ({ ...m, from: name(m.fromAccountId), to: name(m.toAccountId) })),
    oneOffs: inputs.oneOffs
      .filter((o) => o.remaining > 0)
      .map(({ oneOffId, name, account, total, finishDate, held, remaining, toPutIn, needNow, status }) => ({
        oneOffId,
        name,
        account,
        total,
        finishDate,
        held,
        remaining,
        toPutIn,
        needNow,
        status,
      })),
    previous: saved && {
      summary: saved.summary,
      // a plan line shows on its plan move, a line of its own as move -(its index + 1)
      lines: saved.lines.map((l, i) => {
        const id = l.planItemId ?? -(i + 1)
        return { ...l, doneSoFar: current?.moves.find((m) => m.id === id)?.done ?? null }
      }),
    },
  }
}

async function ask(data: unknown, notes: string[], instruction: string | null) {
  const client = await anthropicClient()
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(ShortTermSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `<data>\n${JSON.stringify({ ...(data as object), notes })}\n</data>`,
            instruction?.trim()
              ? `They've asked for this, in their words:\n<request>\n${instruction.trim()}\n</request>`
              : "Work out this pay's transfers.",
          ].join("\n\n"),
        },
      ],
    })
    const response = await stream.finalMessage()
    if (response.stop_reason === "refusal") throw new Error("Cas declined to work out this pay's moves")
    if (response.stop_reason === "max_tokens") throw new Error("Cas's answer was cut off; try again")
    if (!response.parsed_output) throw new Error("Cas returned a malformed answer")
    return response.parsed_output
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}

/** The data's ids, so lines can't point anywhere else. */
function knownIds(basis: AllocationBasis) {
  return {
    mine: new Set(basis.args.mine),
    accounts: new Set(basis.inputs.accounts.map((a) => a.id)),
    planItems: new Set(
      basis.plan.allocations.filter((a) => a.fromAccountId !== null && basis.args.mine.includes(a.fromAccountId)).map((a) => a.id)
    ),
  }
}

async function loadBasis(mine: number[]) {
  const [plan, inputs] = await Promise.all([getCurrentPlan(), loadPlanInputs()])
  return loadAllocationBasis({ mine, plan, inputs })
}

/**
 * Have Cas work out this pay's transfers again, when a sync has brought something in since
 * it last looked (or always, with `force`). Null without a plan, accounts of yours or an
 * Anthropic API key.
 */
export async function refreshShortTerm(opts: { force?: boolean; instruction?: string | null } = {}) {
  // with Cas off a sync only marks the allocation stale (its fingerprint moves on); Claude
  // looks at it with get_short_term and sets it with set_short_term
  if (!casEnabled()) return null
  const { memberId, mine } = await myAccounts()
  if (!(await getApiKey()) || !(await shortTermReady())) return null
  const basis = await loadBasis(mine)
  if (!basis) return null
  const { cycle } = basis.args
  const saved = await getShortTerm(memberId, cycle.start)
  if (!opts.force && saved?.fingerprint === basis.fingerprint) return { shortTerm: saved, looked: false }

  const [notes, fmt] = await Promise.all([getOpenCasNotes(30), getSettings()])
  const answer = await ask(
    casData(basis, saved, fmt.currency),
    notes.filter((n) => n.kind === "decision" || n.kind === "preference").map((n) => `${n.kind}: ${n.content}`),
    opts.instruction ?? null
  )
  const yours = (saved?.lines ?? []).filter((l) => l.by !== "cas")
  const lines = cleanLines(
    answer.lines.map((l) => {
      const line = {
        planItemId: l.plan_item_id,
        title: l.title,
        fromAccountId: l.from_account_id,
        toAccountId: l.to_account_id,
        match: l.match,
        amount: l.amount,
        dueDate: l.due_date,
        reason: l.reason,
      }
      // a line the person set, kept as it was, stays theirs
      const kept = yours.find(
        (y) =>
          y.planItemId === line.planItemId &&
          y.fromAccountId === line.fromAccountId &&
          y.toAccountId === line.toAccountId &&
          y.match === line.match &&
          Math.abs(y.amount - line.amount) < 0.005
      )
      return { ...line, by: kept ? kept.by : ("cas" as const) }
    }),
    knownIds(basis)
  )
  const shortTerm = await saveShortTerm({
    memberId,
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    lines,
    summary: answer.summary,
    fingerprint: basis.fingerprint,
    madeBy: "cas",
  })
  return { shortTerm, looked: true }
}

/** A member's short-term allocation for this pay as it stands, with how each line is going. */
export async function currentShortTerm(forMember?: string) {
  const { memberId, mine } = await myAccounts(forMember)
  const basis = await loadBasis(mine)
  if (!basis) return null
  const saved = await getShortTerm(memberId, basis.args.cycle.start)
  const allocation = myAllocation({ ...basis.args, shortTerm: saved?.lines ?? [] })
  return { memberId, basis, saved, allocation, stale: saved?.fingerprint !== basis.fingerprint }
}

/** Lines checked against the data: an account that isn't theirs or the household's, a plan move not leaving their accounts. */
export function checkLines(lines: Omit<ShortTermLine, "id" | "by">[], known: ReturnType<typeof knownIds>) {
  for (const l of lines) {
    if (!known.mine.has(l.fromAccountId)) throw new Error(`Account ${l.fromAccountId} isn't one of theirs to move from`)
    if (l.toAccountId !== null && !known.accounts.has(l.toAccountId)) throw new Error(`Account ${l.toAccountId} isn't the household's`)
    if (l.planItemId !== null && !known.planItems.has(l.planItemId)) {
      throw new Error(`Plan move ${l.planItemId} isn't one leaving their accounts`)
    }
    if (l.toAccountId === null && l.planItemId === null && !l.match) {
      throw new Error(`"${l.title}" needs a toAccountId or, for money leaving the household, a match`)
    }
  }
}

export { knownIds, loadBasis }

/**
 * Set a member's lines for this pay (the signed-in person by default), replacing the whole
 * list. The fingerprint is saved with them, which clears stale until a sync brings in a new
 * pay or move. `by` is who made the change: claude through the MCP tools, you in the app.
 */
export async function setShortTerm(
  lines: Omit<ShortTermLine, "id" | "by">[],
  summary?: string | null,
  opts: { memberId?: string; by?: "claude" | "you" } = {}
) {
  const by = opts.by ?? "claude"
  const { memberId, mine } = await myAccounts(opts.memberId)
  const basis = await loadBasis(mine)
  if (!basis) throw new Error("There's no plan, or no accounts marked as theirs, to allocate this pay from.")
  const { cycle } = basis.args
  const saved = await getShortTerm(memberId, cycle.start)
  const known = knownIds(basis)
  checkLines(lines, known)
  const cleaned = cleanLines(
    lines.map((l) => ({ ...l, by })),
    known
  )
  const shortTerm = await saveShortTerm({
    memberId,
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    lines: cleaned,
    summary: summary === undefined ? (saved?.summary ?? null) : summary,
    fingerprint: basis.fingerprint,
    madeBy: by,
  })
  return { before: saved, shortTerm }
}
