import "server-only"

import { z } from "zod"

import { CHANGES_DATA, isoDate, tool, type CascadaleTool } from "@/lib/tool"
import { getDb, must } from "@/lib/db"
import { buildSystemGuide, saveGuideText } from "@/lib/planning/guide"
import {
  cycleBudgets,
  cycleModel,
  loadCardPositions,
  loadMemberPosition,
  loadPlanVsActual,
  loadRecurringPayments,
  resolveMember,
} from "@/lib/planning/data"
import {
  PlanItemFields,
  approveChange,
  changeLog,
  listPending,
  planHistory,
  proposeRemove,
  proposeUpsert,
  rejectChange,
} from "@/lib/planning/plan-edit"
import { commitPurchase, runWhatIf } from "@/lib/planning/purchase"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

// Claude's planning tools (see supabase/migrations/20261127000000_claude_planning.sql):
// context, read-only detection, plan editing through pending changes, the short-term
// preview, and affordability. Every write takes a reason and records Claude as its maker.

const memberId = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("The household member, by id or name; defaults to the signed-in person")

const months = z.number().int().min(1).max(12).optional().describe("How many months back to look (default 3)")

const reason = z.string().trim().min(1, "Give a reason").max(500).describe("Why, in the household's words where they gave one")

/** The member who asked: the signed-in person unless another is named. */
async function asker(id?: string) {
  return (await resolveMember(id)).id
}

/** A short-term line as the tools take it. */
export const SHORT_TERM_LINE = {
  planItemId: z.number().int().positive().nullable().describe("The plan move this overrides for this pay (amount 0 skips it); null for a free line"),
  title: z.string().trim().min(1).max(60),
  fromAccountId: z.number().int().positive().describe("One of the member's accounts"),
  toAccountId: z.number().int().positive().nullable().describe("A household account; null when it leaves the household (then give match)"),
  match: z.string().trim().min(1).nullable().optional().describe("For money leaving the household: the merchant key its transactions carry"),
  amount: z.number().nonnegative(),
  dueDate: isoDate.nullable().optional().describe("When it should have gone by; null for straight away"),
  reason: z.string().trim().min(1).max(200),
}

export function toLine(l: {
  planItemId: number | null
  title: string
  fromAccountId: number
  toAccountId: number | null
  match?: string | null
  amount: number
  dueDate?: string | null
  reason: string
}) {
  return { ...l, match: l.match ?? null, dueDate: l.dueDate ?? null }
}

export const PLANNING_TOOLS: CascadaleTool[] = [
  // ── Context ──
  tool({
    name: "get_system_guide",
    title: "System guide",
    access: "read",
    description:
      "Read this first when planning. A markdown guide to this household's Cascadale: the members and their pay schedules (which account each pay lands in), every account with its id, type, owner and purpose, the standing rules from decision notes, what plan items, moves, short-term lines, one-offs, budgets and notes mean, how pay cycles work, the order of operations for planning, and the rules to keep.",
    run: buildSystemGuide,
  }),

  tool({
    name: "update_system_guide",
    title: "Update the system guide",
    access: "action",
    description: `${CHANGES_DATA} Replace the editable part of the system guide (everything after the household's live facts: what things mean, cycles, the order of planning, the rules) when the household asks. Pass the whole new text (get_system_guide's editable field is the current one), or reset: true to go back to the default.`,
    input: {
      markdown: z.string().trim().max(20000).optional(),
      reset: z.boolean().optional(),
    },
    run: async ({ markdown, reset }) => {
      if (!reset && !markdown) throw new Error("Pass the new markdown, or reset: true")
      return saveGuideText(reset ? null : markdown!)
    },
  }),

  tool({
    name: "set_account_purpose",
    title: "Set an account's purpose",
    access: "action",
    description: `${CHANGES_DATA} Say what an account is for (e.g. "Cabin - Cabin King payments", "Daycare and school fees", "Emergency buffer"), and optionally whether its money is free to spend (spendable; null to judge it from the account type). Shown in the system guide and weighed by what_if.`,
    input: {
      accountId: z.number().int().positive(),
      purpose: z.string().trim().max(200).nullable(),
      spendable: z.boolean().nullable().optional(),
    },
    run: async ({ accountId, purpose, spendable }) => {
      const [row] = await must<{ id: number; name: string; purpose: string | null; spendable: boolean | null }[]>(
        (await getDb())
          .from("accounts")
          .update({ purpose: purpose || null, ...(spendable !== undefined && { spendable }) })
          .eq("id", accountId)
          .select("id, name, purpose, spendable")
      )
      if (!row) throw new Error("Account not found")
      return row
    },
  }),

  // ── Detection (read-only) ──
  tool({
    name: "detect_recurring_payments",
    title: "Recurring payments",
    access: "read",
    description:
      'What goes out of the household\'s accounts on a schedule, found from the transactions: grouped by the paying account and the merchant (or, for a transfer between household accounts, the account it goes into: matchKey "to:<id>"). Each has its cadence (weekly, fortnightly, monthly, quarterly), typical, last, min and max amount, last date, next expected date, the paying account and whose it is (owner), and a confidence. Quarterly payments need months of 6 or more to show.',
    input: { months },
    run: async ({ months: m }) => {
      const { today, payments } = await loadRecurringPayments(m ?? 3)
      return { today, months: m ?? 3, count: payments.length, payments }
    },
  }),

  tool({
    name: "plan_vs_actual",
    title: "Plan against actual",
    access: "read",
    description:
      "Each plan item's planned monthly amount against what actually pays it (its recurring payments, or for a budget its category's spending) and who actually pays. Flags amounts more than 5% apart, items paid by someone other than the plan says, items that break a standing rule from a decision note (e.g. a note says Mary pays the school fees but the plan has them on Amit's move), and unplanned: recurring payments no plan item covers. A payment is tied to an item by the item's matchKeys, a transfer from its account into its account, the payment's name in the item's title or notes, then its category. Set matchKeys with upsert_plan_item to tie one exactly.",
    input: { months },
    run: async ({ months: m }) => {
      const out = await loadPlanVsActual(m ?? 3)
      return {
        months: m ?? 3,
        flagged: out.items.filter((i) => i.flags.length > 0).length,
        items: out.items,
        unplanned: out.unplanned,
        standingRules: out.rules,
      }
    },
  }),

  tool({
    name: "cycle_position",
    title: "Pay cycle position",
    access: "read",
    description:
      "Where a member stands in their pay cycle (payday to next payday): the cycle's dates and days left, pay received and still due, each move for this pay (the plan's and their short-term lines) with what's done and left, the bills due before the next payday, the pays still due, the money left in the pay account after bills and planned moves (leftInPayAccount), anything the pay account can't cover when it falls due (uncovered), and budget remaining by category this cycle.",
    input: { memberId },
    run: async ({ memberId: id }) => {
      const p = await loadMemberPosition(id)
      const budgets = await budgetsThisCycle(p)
      return {
        member: p.member.name,
        memberId: p.member.id,
        today: p.today,
        ...p.position,
        shortTerm: {
          madeBy: p.saved?.madeBy ?? null,
          updatedAt: p.saved?.updatedAt ?? null,
          stale: p.saved?.fingerprint !== p.basis.fingerprint,
        },
        budgets,
      }
    },
  }),

  tool({
    name: "credit_card_due",
    title: "Credit cards due",
    access: "read",
    description:
      "Each credit card: what's owed, and when it's usually paid. Akahu doesn't give the statement balance, due date or minimum payment, so statement is null and the due date comes from the household's pattern of paying the card (the recurring payments into it: who pays, how much, how often, next expected), with the monthly spend on it against what's paid in and whether it looks cleared each time.",
    run: async () => ({ today: todayLocal(), cards: await loadCardPositions(3) }),
  }),

  // ── The plan ──
  tool({
    name: "upsert_plan_item",
    title: "Propose a plan item",
    access: "action",
    description: `${CHANGES_DATA} Propose adding a plan item (no id) or changing one (id; fields left out keep their value). It becomes a pending change: nothing in the plan moves until a member approves it with approve_change (either member for a shared item, its owner for a personal one). Rejected when it breaks a standing rule from a decision note (who pays for what) unless override is true. purpose is bills, budget, one_off, savings, goal, buffer or debt; every is week, fortnight, month or once.`,
    input: {
      id: z.number().int().positive().optional().describe("The plan item to change; omit to add one"),
      ...PlanItemFields.partial().shape,
      reason,
      override: z.boolean().optional().describe("Allow a change that breaks a standing rule (only when the household has said so)"),
      askedBy: memberId.describe("Who asked for it; defaults to the signed-in person"),
    },
    run: async ({ id, reason: why, override, askedBy, ...fields }) =>
      proposeUpsert({ id, ...fields }, { askedBy: await asker(askedBy), madeBy: "claude", reason: why }, { override }),
  }),

  tool({
    name: "remove_plan_item",
    title: "Propose removing a plan item",
    access: "action",
    description: `${CHANGES_DATA} Propose removing a plan item. It's a pending change until a member approves it, and then a soft delete: the item leaves the plan but its history stays (get_plan_history).`,
    input: { id: z.number().int().positive(), reason, askedBy: memberId },
    run: async ({ id, reason: why, askedBy }) =>
      proposeRemove(id, { askedBy: await asker(askedBy), madeBy: "claude", reason: why }),
  }),

  tool({
    name: "get_plan_history",
    title: "Plan item history",
    access: "read",
    description: "Every change to one plan item, oldest first: who asked, who made it (claude or you), why, and its values before and after; plus the pending changes about it.",
    input: { id: z.number().int().positive() },
    run: ({ id }) => planHistory(id),
  }),

  tool({
    name: "list_pending_changes",
    title: "Pending plan changes",
    access: "read",
    description: "Long-term plan changes waiting for approval (or, with status, those approved or rejected): what each would do (payload against before), why, who asked, and who can approve it.",
    input: { status: z.enum(["pending", "approved", "rejected", "all"]).optional() },
    run: ({ status }) => listPending(status ?? "pending"),
  }),

  tool({
    name: "approve_change",
    title: "Approve a plan change",
    access: "action",
    description: `${CHANGES_DATA} Approve a pending plan change and apply it, as the member named. Only call this when that member has seen the change and said yes in this conversation; never on your own judgement and never in a scheduled run. memberId must be the signed-in person (someone else approves in their own session), and a personal item's change only its owner can approve.`,
    input: { id: z.number().int().positive(), memberId: z.string().trim().min(1).describe("The approving member, by id or name: the signed-in person") },
    run: ({ id, memberId: who }) => approveChange(id, who, "claude"),
  }),

  tool({
    name: "reject_change",
    title: "Reject a plan change",
    access: "action",
    description: `${CHANGES_DATA} Reject a pending plan change as the member named (the signed-in person), with their reason. The plan stays as it is.`,
    input: { id: z.number().int().positive(), memberId: z.string().trim().min(1), reason },
    run: ({ id, memberId: who, reason: why }) => rejectChange(id, who, why, "claude"),
  }),

  tool({
    name: "get_change_log",
    title: "Change log",
    access: "read",
    description: "Every change to the plan, the short-term allocations and committed purchases since a date (default the last 30 days), newest first: who asked, who made it (claude or you), why, and the values before and after. Pending changes show when proposed, approved or rejected.",
    input: { since: isoDate.optional() },
    run: ({ since }) => changeLog(since),
  }),

  // ── This pay ──
  tool({
    name: "preview_short_term",
    title: "Preview this pay's moves",
    access: "read",
    description:
      "Try a member's short-term lines without saving them: the pay account's balance after the bills and moves still to come (leftInPayAccount), and any bill or move it would leave uncovered, against the lines as they are now. Lines are as set_short_term takes them.",
    input: {
      memberId,
      lines: z.array(z.object(SHORT_TERM_LINE)).describe("Every line for this pay, as set_short_term would save them"),
    },
    run: async ({ memberId: id, lines }) => {
      const [now, next] = await Promise.all([loadMemberPosition(id), loadMemberPosition(id, { lines: lines.map(toLine) })])
      const brief = (x: typeof now.position) => ({
        leftInPayAccount: x.leftInPayAccount,
        leftInYourAccounts: x.leftInYourAccounts,
        movesLeft: x.movesLeft,
        uncovered: x.uncovered,
      })
      return {
        member: next.member.name,
        payAccount: next.position.payAccount,
        nextPayday: next.position.cycle.end,
        current: brief(now.position),
        withTheseLines: brief(next.position),
        moves: next.position.moves,
        billsDue: next.position.billsDue,
        saved: false,
      }
    },
  }),

  // ── Affordability ──
  tool({
    name: "what_if",
    title: "What if we buy this?",
    access: "read",
    description:
      "Weigh a purchase against a member's real numbers, saving nothing. Returns a verdict (affordable, affordable_with_changes with the changes, or not_affordable) with a headline; the effect on this pay cycle (left in the pay account after bills and planned moves, then after usual spending to payday) and the next three; each savings goal and buffer with how many weeks each option delays it; bills left uncovered; every option weighed (pay now, on the card, wait for the next pay, spread over pays, use a buffer, hold back a goal) with its knock-on effects; and the working context: every account's balance and whether it's spendable or earmarked, bills and one-offs due before payday and over 90 days, budgets this cycle against the last three, the credit card, the other member's shared moves, recent irregular spending, and the assumptions with how sure each is. Pass its whatIfId to commit_purchase once they say yes.",
    input: {
      memberId,
      amount: z.number().positive(),
      date: isoDate.optional().describe("When they'd buy it; defaults to today"),
      accountId: z.number().int().positive().optional().describe("The account it would come from (a card account puts it on the card); defaults to their pay account"),
      description: z.string().trim().min(1).max(120).describe("What it is, e.g. 'iPad'"),
      spreadOver: z.number().int().min(2).max(12).optional().describe("Pays to spread it over; 2 and 3 are weighed when omitted"),
    },
    run: ({ memberId: id, amount, date, accountId, description, spreadOver }) =>
      runWhatIf({
        memberId: id,
        amount,
        date: date ?? todayLocal(),
        accountId: accountId ?? null,
        description,
        spreadOver: spreadOver ?? null,
      }),
  }),

  tool({
    name: "commit_purchase",
    title: "Go ahead with a purchase",
    access: "action",
    description: `${CHANGES_DATA} Once they've said yes to a what_if option: record the purchase as a one-off and apply the option, worked out again with today's numbers. An option that only touches this pay (pay_now, card, use_buffer, pause_goal, wait_until_next_pay) updates their short-term allocation straight away where it needs to; one that changes the long-term plan (spread_over_N) creates a pending change for a member to approve. Every change is logged with the reason.`,
    input: {
      whatIfId: z.string().trim().min(4),
      option: z.string().trim().min(1).describe("An option id from what_if, e.g. pay_now, wait_until_next_pay, spread_over_3, pause_goal"),
      reason,
    },
    run: ({ whatIfId, option, reason: why }) => commitPurchase(whatIfId, option, why),
  }),
]

/** Each budget's share for this cycle against what's been spent from the member's and joint accounts. */
async function budgetsThisCycle(p: Awaited<ReturnType<typeof loadMemberPosition>>) {
  const model = await cycleModel(p)
  return (await cycleBudgets(p, model)).map((b) => ({
    categoryId: b.categoryId,
    name: b.name,
    cycleBudget: b.cycleBudget,
    spentThisCycle: b.spentThisCycle,
    remainingThisCycle: b.remainingThisCycle,
  }))
}
