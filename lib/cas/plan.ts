import "server-only"

import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import { getDb, must } from "@/lib/db"
import { PLAN_EVERY, PLAN_VERDICTS } from "@/lib/db/schema"
import { CAS_DISABLED_MESSAGE, casEnabled } from "@/lib/flags"

/** The purposes Cas's plans used; debt came later, with Claude's plan tools. */
const PLAN_PURPOSES = ["bills", "budget", "one_off", "savings", "goal", "buffer"] as const
import { loadPlanInputs, type PlanInputs } from "@/lib/plan-inputs"
import { getOpenCasNotes } from "@/lib/queries"

// Cas makes the plan: it reads the plan inputs (income, budgets against projections, bills,
// one-offs, accounts) and your goals, says plainly whether the goals are realistic, and lays
// out allocations (where the money goes, on a schedule) and actions (what to do). One model
// call with a structured answer; the figures come from lib/plan-inputs.ts, never the model.

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 32000

const CasPlanSchema = z.object({
  summary: z.string().describe("Two or three plain sentences: the plan in short, leading with the monthly numbers"),
  verdict: z
    .enum(PLAN_VERDICTS)
    .describe("realistic: goals and budgets fit the income; stretch: they fit only if spending is held to budget or with little margin; unrealistic: they don't fit"),
  verdict_note: z
    .string()
    .describe("One to three sentences on why, with the deciding numbers. If anything is unrealistic, say what would make it work (a smaller amount, a later date, a budget to cut)."),
  goal_checks: z
    .array(
      z.object({
        goal: z.string().describe("The goal in a few words, as they put it"),
        fits: z.boolean(),
        note: z.string().describe("At most 30 words: what it needs per month against what's spare, and what to change if it doesn't fit"),
      })
    )
    .describe("Each goal they gave, weighed against the figures. Empty if they gave none."),
  allocations: z
    .array(
      z.object({
        purpose: z.enum(PLAN_PURPOSES),
        title: z.string().describe("At most 6 words, e.g. 'Bills', 'Groceries', 'Car rego', 'Emergency fund'"),
        detail: z.string().nullable().describe("One short sentence: what it covers or why this amount"),
        amount: z.number().nonnegative().describe("Amount per `every`, rounded to a tidy figure"),
        every: z.enum(PLAN_EVERY),
        category_id: z.number().int().nullable().describe("For a budget allocation: the category's id from the data"),
        one_off_id: z.number().int().nullable().describe("For a one-off allocation: its id from the data"),
        account_id: z.number().int().nullable().describe("Where the money should sit, an account id from the data, or null"),
        from_account_id: z
          .number()
          .int()
          .nullable()
          .describe("For money to move by hand (savings, goals, one-offs, debt paydown, transfers into a bills account): the account it leaves from, usually the account the paying income lands in (incomeSources[].accountId). Null when nothing moves, e.g. spending that happens where the money already is."),
      })
    )
    .describe("Where each pay's money goes, covering all of income: bills, budgets, one-offs, then savings, goals and a buffer from what's left. Together they should add up to income (per month)."),
  actions: z
    .array(
      z.object({
        title: z.string().describe("At most 8 words, imperative"),
        detail: z.string().nullable().describe("One sentence with the key number"),
        due_date: z.string().nullable().describe("yyyy-MM-dd to do it by, or null"),
      })
    )
    .describe("Two to six concrete things to do now, most important first, e.g. set up an automatic transfer, raise or lower a budget, top up a one-off that's behind"),
})
export type CasPlan = z.infer<typeof CasPlanSchema>

const SYSTEM = `You are Cas, the financial accountant and manager for one household, inside their private budgeting app. You make their plan: from their projected income, the budgets they set, their recurring bills and their one-off payments, you say whether it all fits and lay out where every pay goes.

The data (amounts in their currency, monthly unless said otherwise):
- figures: income (projected), committed (each expense category's budget, else its projection), projectedSpend (what spending runs at, budgets aside), oneOffs (what one-off payments need each month on average), leftOver (income − committed − oneOffs), leftOverAsProjected (the same with spending as it runs), tightBudgets (budgets set well below how the category has been running).
- incomeSources: each regular income with cadence, amount per payment, monthly equivalent, next date and account.
- categories: each expense category's projection, budget (monthly equivalent), budget period and, if set, the budget as a % of income.
- bills: recurring bills within those categories.
- oneOffs: one-off payments still to pay: total, finish date, held, still to put in, monthly need, needNow (behind schedule) and status.
- accounts: balances, which are debt (loans, revolving credit, an overdrawn account) and who holds each, with interestRate (annual %, null when unknown).
- notes: what you remember about their decisions and preferences.

Be realistic. A budget well under how a category has been running is a hope, not a plan: say so and plan with the realistic figure unless they've said they'll cut it. Goals that need more than leftOver (or leftOverAsProjected if their budgets are tight) don't fit: mark them, give the number they'd need, and say what would make them fit (a smaller amount, a later date, a named budget to cut). Never make the numbers work by quietly assuming less spending.

The plan:
- Allocations cover every dollar of income per month: bills, each budgeted category (or groups of small ones), each one-off's monthly need (use its oneOffId), then savings, goals and a buffer from what's left. Use the pay cadence the income actually arrives on (fortnight for a fortnightly pay) when it makes the transfers easier. If income doesn't cover it, say so and leave the shortfall visible rather than inventing money.
- Use ids only from the data. Refer to accounts and categories by name in text, never by id.
- Debt against savings: when a debt has an interestRate above what a savings account earns, money beyond an emergency buffer does more paying the debt down; say what that's worth a year (balance × rate difference). When a rate is unknown, say that knowing it would settle it.
- Mark where money moves from (from_account_id) on every allocation that has to be moved by hand, so on payday the app can say what to move from the account the pay landed in.
- Actions are concrete next steps they can do this week. Leave out trivial ones (a top-up of a dollar or two).

Keep every text short and plain: lead with the number, no preamble.`

/** Ask Cas for a plan from today's inputs and these goals, and save it as the current plan. */
export async function makePlan(goals: string | null, madeBy: "website" | "mcp") {
  if (!casEnabled()) throw new Error(CAS_DISABLED_MESSAGE)
  const inputs = await loadPlanInputs()
  if (!inputs) throw new Error("Import some transactions first, so there's something to plan from.")
  const notes = (await getOpenCasNotes(30)).filter((n) => n.kind === "decision" || n.kind === "preference")
  const plan = await ask(inputs, goals, notes.map((n) => `${n.kind}: ${n.content}`))
  return { planId: await save(plan, inputs, goals, madeBy), plan }
}

async function ask(inputs: PlanInputs, goals: string | null, notes: string[]) {
  const client = await anthropicClient()
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(CasPlanSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Today is ${inputs.today}. Currency: ${inputs.currency}.`,
            `<data>\n${JSON.stringify({ ...inputs, notes })}\n</data>`,
            goals?.trim()
              ? `Their goals, in their words:\n<goals>\n${goals.trim()}\n</goals>`
              : "They haven't given goals: plan to cover everything, then build a buffer and savings from what's left.",
          ].join("\n\n"),
        },
      ],
    })
    const response = await stream.finalMessage()
    if (response.stop_reason === "refusal") throw new Error("Cas declined to make a plan")
    if (response.stop_reason === "max_tokens") throw new Error("Cas's plan was cut off; try again")
    if (!response.parsed_output) throw new Error("Cas returned a malformed plan")
    return response.parsed_output
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}

/** Save the plan and its items; ids the data doesn't have are dropped rather than trusted. */
async function save(plan: CasPlan, inputs: PlanInputs, goals: string | null, madeBy: "website" | "mcp") {
  const db = await getDb()
  const categoryIds = new Set(inputs.categories.flatMap((c) => (c.categoryId === null ? [] : [c.categoryId])))
  const oneOffIds = new Set(inputs.oneOffs.map((o) => o.oneOffId))
  const accountIds = new Set(inputs.accounts.map((a) => a.id))
  const known = (set: Set<number>, id: number | null) => (id !== null && set.has(id) ? id : null)
  const isDate = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

  const { id: planId } = await must<{ id: number }>(
    db
      .from("plans")
      .insert({
        goals: goals?.trim() || null,
        summary: plan.summary,
        verdict: plan.verdict,
        verdict_note: plan.verdict_note,
        goal_checks: plan.goal_checks,
        figures: {
          income: inputs.figures.income,
          committed: inputs.figures.committed,
          oneOffs: inputs.figures.oneOffs,
          leftOver: inputs.figures.leftOver,
        },
        made_by: madeBy,
      })
      .select("id")
      .single()
  )
  const items = [
    ...plan.allocations.map((a, i) => ({
      plan_id: planId,
      kind: "allocation",
      purpose: a.purpose,
      title: a.title,
      detail: a.detail,
      amount: Math.round(a.amount * 100) / 100,
      every: a.every,
      category_id: known(categoryIds, a.category_id),
      one_off_id: known(oneOffIds, a.one_off_id),
      account_id: known(accountIds, a.account_id),
      from_account_id: known(accountIds, a.from_account_id),
      position: i,
    })),
    ...plan.actions.map((a, i) => ({
      plan_id: planId,
      kind: "action",
      title: a.title,
      detail: a.detail,
      due_date: isDate(a.due_date),
      position: i,
    })),
  ]
  if (items.length) await must(db.from("plan_items").insert(items))
  return planId
}
