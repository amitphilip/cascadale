import { z } from "zod"

import type { CasNote } from "@/lib/db/schema"
import type { PlanFigures } from "@/lib/plan-figures"

import type { SnapshotWarning } from "./store"

/**
 * The one judgement Cas's background run asks a model for: a headline, the few things to do
 * next, and changes worth proposing. The numbers are worked out beforehand (lib/plan-figures.ts)
 * and passed in; the model never computes them. Defined over an injected runner so the
 * worker's tests don't call a model (lib/cas/judge-claude.ts is the real one).
 */

/** Tools Cas may propose; each runs through the shared layer once you approve it. */
export const PROPOSABLE_TOOLS = [
  "upsert_pot",
  "remove_pot",
  "add_plan_adjustment",
  "remove_plan_adjustment",
  "add_plan_action",
  "set_plan_action_done",
  "add_upcoming_expense",
  "categorize_merchant",
  "set_transaction_category",
  "set_category_budgets",
] as const
export type ProposableTool = (typeof PROPOSABLE_TOOLS)[number]

export const JudgementSchema = z.object({
  headline: z.string().describe("One plain sentence on where things stand, leading with the deciding number"),
  topActions: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().nullable(),
        actionId: z.number().int().nullable().describe("The open plan action item this is, if it is one"),
        dueDate: z.string().nullable().describe("yyyy-MM-dd"),
      })
    )
    .describe("At most five, most important first"),
  proposals: z
    .array(
      z.object({
        tool: z.enum(PROPOSABLE_TOOLS),
        args: z.string().describe("The tool's arguments as a JSON object, without operationId"),
        reason: z.string().describe("Why, in a sentence, with the number that decides it"),
      })
    )
    .describe("Concrete changes to propose; none is fine. Never undo a person's decision."),
  keepProposalIds: z
    .array(z.number().int())
    .describe("Pending proposals that still hold on today's data; the rest are superseded"),
  notes: z
    .array(z.object({ kind: z.enum(["observation", "todo"]), content: z.string() }))
    .describe("Anything to remember for later runs, including disagreements with a person's decision"),
  resolveNotes: z
    .array(z.object({ noteId: z.number().int(), resolution: z.string() }))
    .describe("Discrepancy notes (and others) that today's figures settle, with how"),
  uncertain: z.boolean().describe("True when the data doesn't support a confident read"),
})
export type Judgement = z.infer<typeof JudgementSchema>

export type JudgeInput = {
  today: string
  figures: PlanFigures
  warnings: SnapshotWarning[]
  /** changes people made recently: decisions Cas must respect */
  decisions: { at: string; actor: string; action: string; summary: string | null; reason: string | null }[]
  /** changes since the last snapshot, by anyone */
  recentChanges: { at: string; actor: string; action: string; summary: string | null }[]
  openNotes: Pick<CasNote, "id" | "kind" | "content">[]
  pendingProposals: { proposalId: number; tool: string; args: unknown; reason: string }[]
  /** proposals a person turned down recently: don't propose them again */
  rejectedProposals: { tool: string; args: unknown; reason: string; decisionReason: string | null }[]
  previous: { status: string; headline: string; goalGap: number | null } | null
}

export type JudgeResult = {
  judgement: Judgement
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export type Judge = (input: JudgeInput, model: string) => Promise<JudgeResult>

export const JUDGE_SYSTEM = `You are Cas, the accountant and financial manager for one household, working in the background of their budgeting app. After each bank sync or plan change you write a short "state of play" that Claude reads when they ask how things are going.

You're given the figures, already worked out: status, the goal's gap, the low point, spare cash, drift and each action item's status. Never recompute or contradict them; quote them. Your job is judgement:
- headline: one sentence, leading with the number that matters most.
- topActions: the few things to do next, most important first. Link open plan action items by actionId. Overdue ones come first.
- proposals: concrete changes worth making, each as a tool call with JSON args (no operationId): a pot or adjustment that fixes an overdraft or an uncovered bill, ticking off an action the data shows is done, a merchant to categorise. Only propose what the figures support. None is fine.
- decisions lists changes people made. They are decisions: never propose undoing or reversing one. If you disagree, say so in a note (kind observation) instead.
- rejectedProposals were turned down: don't propose them again.
- keepProposalIds: pending proposals that still hold. Leave out ones the latest changes or data make stale.
- notes: things to remember, e.g. a disagreement or a pattern. Don't repeat open notes.
- openNotes of kind discrepancy are reports that the raw data disagrees with your last snapshot. Check them against the figures: if the figures now agree, resolve them in resolveNotes saying so; if the data really is off (stale feed, drift, an action done but not ticked), say so in the headline or a top action, and resolve them once there's nothing left to reconcile.
- uncertain: true when stale feeds, drift or missing data mean you can't give a confident read.
Use New Zealand English, plain and short, amounts in dollars, accounts and pots by name.`
