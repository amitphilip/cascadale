import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import type { PlanMessage } from "@/lib/db/schema"
import {
  describeSimulation,
  planDataContext,
  FORTNIGHTLY,
  MONTHLY,
  PlannerTurnSchema,
  sanitizePlan,
  simulate,
  type Frequency,
  type Plan,
  type PlannerTurn,
  type PlanSnapshot,
} from "@/lib/plan"
import {
  getAccountsWithBalances,
  getAverageWindow,
  getCategories,
  getPlanTransactions,
  getRecurringInputs,
  getSettings,
  getUpcomingExpenses,
} from "@/lib/queries"
import { applyPots, potSetAside, type PotInstruction } from "@/lib/plan-instructions"
import { snapshotFromData } from "@/lib/snapshot"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 64000

/** Your finances as the planner sees them, or null before any transactions are imported. */
export async function loadSnapshot(): Promise<PlanSnapshot | null> {
  return (await loadPlanData())?.snapshot ?? null
}

/** The snapshot plus the recurring series and transactions it was built from. */
export async function loadPlanData() {
  const [window, categories, accounts, fmt, upcoming] = await Promise.all([
    getAverageWindow(),
    getCategories(),
    getAccountsWithBalances(),
    getSettings(),
    getUpcomingExpenses(),
  ])
  if (!window) return null
  const [txs, { overrides, projections }] = await Promise.all([
    getPlanTransactions(window),
    getRecurringInputs(null),
  ])
  return snapshotFromData({
    window,
    accounts,
    categories,
    txs,
    overrides,
    projections,
    upcoming,
    currency: fmt.currency,
    today: todayLocal(),
  })
}

const SYSTEM = `You are a careful personal-finance planner inside a private budgeting app used by one person or household. You turn their analysed bank data into a practical cash plan and then refine it with them in conversation.

The problem you solve: income arrives on paydays, but bills fall due on other days. Your plan says, for each payday, how much to move or earmark from the account the pay lands in into named pots, so that every bill is already funded when it is due and day-to-day spending money is what's left.

The data you get (amounts in the stated currency):
- accounts: id, name, type and current balance. Credit card and loan balances are negative when owed.
- incomes: recurring income with an id (I1, I2…), the account it lands in, cadence, amount per payment, monthly equivalent and next date.
- bills: recurring expenses with an id (B1, B2…), the account they are charged to, cadence, amount per occurrence, monthly equivalent and next date. Quarterly and yearly bills need saving up for over several paydays.
- variable: day-to-day spending not on a schedule, per category and account, per month.
- otherIncome: income not on a schedule, per month.
- budgets: per expense category, the person's budget (if set) and the app's projection.
- upcoming: one-off expenses the person expects, with an id (U1, U2…), date, amount and account (null if undecided). They are not recurring: plan for them by temporarily raising a set-aside in the paydays before, or by drawing on a buffer, and mention it in focus or warnings.
Transfers between the person's own accounts are excluded from all of this, including credit card repayments. Bills and spending charged to a credit card still have to be paid from a cash account.

How to build the plan:
- One set_aside entry per pot per income that funds it. income_id is the income whose payday triggers it, "${FORTNIGHTLY}" for every 14 days (lined up with a fortnightly payday when there is one), or "${MONTHLY}" for the 1st of the month. from_account_id must be the account that income lands in (or, for ${FORTNIGHTLY} and ${MONTHLY}, one the money will be in by then).
- The person says how often they want to move money. Every payday: use the incomes' own ids, with ${MONTHLY} only when no regular income fits. Every fortnight: use a fortnightly income's id if one fits, else ${FORTNIGHTLY}. Once a month: use a monthly income's id if one fits, else ${MONTHLY}. Stick to that unless they ask to change it.
- to_account_id is where the pot's money should sit: usually the account the covered bills are charged from, so they clear without another transfer; a savings account for pots saving up for quarterly or yearly bills; null to earmark it in the from account. For bills on a credit card, keep the pot in the cash account that pays the card off.
- Size each entry so the pot's monthly inflow matches the monthly cost of the bills it covers: monthly cost divided by how often that income arrives per month, rounded up to a tidy amount. With several incomes, split sensibly (e.g. in proportion to income, or by which payday lands closest before the bill).
- Group bills into a handful of clear pots (e.g. Housing, Utilities, Insurance, Subscriptions, Debt, Annual bills) rather than one pot per bill. Every bill should be in exactly one pot's covers.
- If there's room after bills and day-to-day spending, add a buffer or savings pot. If income doesn't cover bills plus spending, say so plainly and prioritise essentials.
- After each turn the app simulates the current plan for 90 days and tells you the result: each pot's inflow, outflow and the starting balance it needs, uncovered bills, and cash accounts that go below zero. Use it to check and correct your plan.

Focus suggestions: three to six concrete things worth the person's attention, most important first, each grounded in specific numbers from the data (a growing bill, an expensive subscription, spending over budget, a thin buffer, an annual bill coming up). Give a monthly_impact estimate when you can.

What the person sees: the app renders the plan's summary, set-asides, focus and warnings as a dashboard, and your reply as a chat message beside it. So every plan you return must carry its focus items and warnings in those fields, even when they haven't changed; don't put them only in your reply, and don't repeat the whole plan there.

Keep every text short and plain: the person wants to glance at the dashboard, not read it. Follow the word limits on each field, lead with the number, and skip explanations the numbers already show.

In conversation: answer questions and make the changes asked for. For a first plan, reply with one or two sentences introducing it. Otherwise reply in a few short lines of plain text (short paragraphs or "- " lists, no headings or tables). When the plan changes, return the complete revised plan, not just the changed parts; when you only answer a question, return plan as null. Refer to accounts, incomes and bills by name in your reply, never by id. Use only ids that appear in the data. Don't invent facts the data doesn't show; when you assume something, say so.`

const fence = (tag: string, body: string) => `<${tag}>\n${body}\n</${tag}>`

/** Conversation replayed for the model, oldest first; the thread's first message carries the data. */
function history(messages: Pick<PlanMessage, "role" | "content" | "context" | "plan">[]) {
  return messages.map(
    (m): Anthropic.Beta.BetaMessageParam =>
      m.role === "user"
        ? { role: "user", content: m.context ? `${m.context}\n\n${m.content}` : m.content }
        : { role: "assistant", content: JSON.stringify({ reply: m.content, plan: m.plan }) }
  )
}

async function ask(messages: Anthropic.Beta.BetaMessageParam[]): Promise<PlannerTurn> {
  const client = await anthropicClient()
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(PlannerTurnSchema) },
      // the conversation only ever grows, so cache up to its latest turn
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      messages,
    })
    const response = await stream.finalMessage()
    if (response.stop_reason === "refusal") throw new Error("The model declined to answer")
    if (response.stop_reason === "max_tokens") throw new Error("The model's answer was cut off; try again")
    if (!response.parsed_output) throw new Error("The model returned a malformed plan")
    return response.parsed_output
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}

export type NewTurn = {
  user: { content: string; context: string }
  assistant: { content: string; plan: Plan | null }
}

const FREQUENCY_ASK: Record<Frequency, string> = {
  payday: "I want to move money into pots every payday.",
  fortnightly: "I want to move money into pots once every fortnight.",
  monthly: "I want to move money into pots once a month.",
}

/**
 * Pots you set yourself (from the website, Claude or Cas), for the model: it plans around
 * them, and applyPots puts them back exactly as set whatever it returns.
 */
function potsContext(pots: PotInstruction[], snapshot: PlanSnapshot) {
  const live = pots.filter((p) => !p.removed)
  const removed = pots.filter((p) => p.removed)
  if (!live.length && !removed.length) return ""
  const lines = live.flatMap((p) => {
    const { entry } = potSetAside(p, snapshot)
    return entry ? [`- ${JSON.stringify(entry)}`] : []
  })
  return [
    "",
    lines.length ? `My own pots, which stay exactly as set (plan the rest around them):\n${lines.join("\n")}` : "",
    removed.length ? `Pots I removed, which must not come back: ${removed.map((p) => p.name).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Start a conversation: the snapshot plus your goals, answered with a first plan. */
export async function startPlan(
  snapshot: PlanSnapshot,
  goals: string,
  frequency: Frequency,
  pots: PotInstruction[] = []
): Promise<NewTurn> {
  const user = {
    content: goals || "Make me a plan.",
    context: `${planDataContext(snapshot)}\n\n${FREQUENCY_ASK[frequency]}${potsContext(pots, snapshot)}`,
  }
  const turn = await ask(history([{ role: "user", ...user, plan: null }]))
  if (!turn.plan) throw new Error("The model didn't return a plan")
  const plan = applyPots(sanitizePlan(turn.plan, snapshot), pots, snapshot).plan
  return { user, assistant: { content: turn.reply, plan } }
}

/** Continue a conversation with a question or change request. */
export async function continuePlan(
  snapshot: PlanSnapshot,
  messages: PlanMessage[],
  text: string,
  pots: PotInstruction[] = []
): Promise<NewTurn> {
  const current = latestPlan(messages)
  const user = {
    content: text,
    context:
      (current
        ? fence("simulation_of_current_plan", describeSimulation(snapshot, simulate(snapshot, current)))
        : "") + potsContext(pots, snapshot),
  }
  const turn = await ask(history([...messages, { role: "user", ...user, plan: null }]))
  return {
    user,
    assistant: {
      content: turn.reply,
      plan: turn.plan && applyPots(sanitizePlan(turn.plan, snapshot), pots, snapshot).plan,
    },
  }
}

export function latestPlan(messages: Pick<PlanMessage, "plan">[]) {
  return messages.findLast((m) => m.plan)?.plan ?? null
}
