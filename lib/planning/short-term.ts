import "server-only"

import { getUserId } from "@/lib/db"
import { loadAllocationBasis, type AllocationBasis } from "@/lib/month"
import { myAllocation } from "@/lib/my-allocation"
import { getCurrentPlan } from "@/lib/plan-data"
import { loadPlanInputs } from "@/lib/plan-inputs"
import { getAccountHolders } from "@/lib/queries"
import { cleanLines, type ShortTermLine } from "@/lib/short-term"
import { getShortTerm, saveShortTerm } from "@/lib/short-term-data"

// Each member's short-term allocation: the transfers for their pay this pay cycle, on top of
// the plan (the long-term allocation). Claude sets it through the MCP tools and the household
// in the app; a sync that brings in a pay or a move marks it stale (its fingerprint moves on).
// The figures come from lib/my-allocation.ts and lib/short-term.ts.

/** A household member (the signed-in person by default) and the accounts that are theirs. */
export async function myAccounts(memberId?: string) {
  const [id, holders] = await Promise.all([memberId ?? getUserId(), getAccountHolders()])
  return { memberId: id, mine: [...holders].filter(([, h]) => h === id).map(([a]) => a) }
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
