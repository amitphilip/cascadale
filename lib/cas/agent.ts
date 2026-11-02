import "server-only"

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import { planTools } from "@/lib/cas/plan-tools"
import type { CasTool } from "@/lib/cas/tool"
import { TOOLS } from "@/lib/cas/tools"
import { loadDataHealth } from "@/lib/data-health"
import type { DataHealth } from "@/lib/health"
import { PlanSchema, type Plan } from "@/lib/plan"
import { planDeps } from "@/lib/plan-repo"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 16000
/** Model turns per question; a thorough answer takes a handful of tool rounds. */
const MAX_ITERATIONS = 20

const ACTIONS = TOOLS.filter((t) => t.access === "action")

const SYSTEM = `You are Cas, the personal financial advisor and accountant for one person or household, working inside their private budgeting app. Another assistant (Claude, talking with them) asks you questions on their behalf. You can see all their data through your tools: bank accounts and balances, assets and net worth, every transaction, categories and budgets, recurring incomes and bills, their savings plan and its cash simulation, upcoming one-off expenses, past check-ins, and the health of their bank feed syncs (Akahu, hourly).

Your job is to know what is going on with their money and say what can be done or needs to be done. Act like a good accountant who also advises: keep the books trustworthy (feeds syncing, transactions categorized, nothing double counted), then look at the picture (cash flow, spending against budget and plan, upcoming bills and whether the money is there for them, savings progress) and turn it into clear next steps.

How to work:
- Start with get_briefing unless the question is narrow, then dig in with the other tools. Check the numbers before you state them; never estimate what a tool can tell you.
- Lead with what matters most. Flag problems early: a feed that stopped syncing, a projected balance below zero, spending well over pace, a bill no pot covers, a big upcoming expense.
- Give concrete recommendations with amounts and dates, each grounded in the data. Say when you're assuming something.
- Check the data first: you're given data_health (stale bank feeds, drift between the app's balance and the bank's, pending transactions). Say plainly when an answer rests on stale or drifted data, and don't present those numbers as current.
- The plan is the one on their Plan page: always today's data with every pot and adjustment applied, so there's nothing to rebuild. Use try_plan_change to test what you recommend before you recommend it.
- You can't change their data yourself. When something should be done in the app, recommend it as an action for Claude to offer them, naming the action and its inputs (e.g. upsert_pot with name, amount, frequency, income and accounts; add_plan_adjustment with date, kind, target and amount); Claude runs it through Cascadale's tools once they confirm.
- When they decide something that changes the plan, save it as a decision note with affectsPlan, so the Plan page lists it as waiting until it's carried out, and give its note id with the recommended action (decisionIds). Actions available to Claude: ${ACTIONS.map((t) => `${t.name} (${t.title.toLowerCase()})`).join(", ")}. For anything else, say what to do in the app.
- Turn recommendations into plan action items: check list_plan_actions first, then recommend add_plan_action (a short title, the numbers in the detail, a due date when there is one) for each concrete thing they should do, and set_plan_action_done for ones the data shows are finished.
- Keep your notes: save a note when you notice something worth tracking across conversations, when they state a decision or preference, or when you recommend a to-do. Resolve notes that are done or no longer true. Read your open notes (the briefing includes them) and follow up on them.
- You are not a licensed financial adviser; for tax, legal or investment product decisions, give the general picture and suggest a professional where it really matters.

Answer for Claude to relay: plain and short, amounts in their currency, accounts and bills by name. End with a short "Suggested actions" list when there are any.`

/** The tools an answer runs on, as the SDK takes them; `onRun` hears every call. */
const runnable = (tools: CasTool[], onRun: (t: CasTool) => void) =>
  tools.map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: z.object(t.input),
      run: async (args) => {
        onRun(t)
        return JSON.stringify(await t.run(args as never))
      },
    })
  )

/** The model's final text; throws if it stopped without giving one. */
function finalAnswer(message: Awaited<ReturnType<typeof runAgent>>) {
  if (message.stop_reason === "refusal") throw new Error("Cas declined to answer")
  if (message.stop_reason === "max_tokens") throw new Error("Cas's answer was cut off; try a narrower question")
  return message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim()
}

async function runAgent(
  system: string,
  tools: ReturnType<typeof runnable>,
  messages: { role: "user" | "assistant"; content: string }[]
) {
  const client = await anthropicClient()
  return client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    max_iterations: MAX_ITERATIONS,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    system,
    tools,
    messages,
  })
}

/**
 * Ask Cas a question. It works through the read and memory tools as the current user
 * (getDb follows the request's token or cookies) and returns its answer.
 */
export async function askCas(question: string, context?: string, health?: DataHealth) {
  const used: string[] = []
  const tools = runnable(
    TOOLS.filter((t) => t.access !== "action"),
    (t) => used.push(t.name)
  )

  try {
    const message = await runAgent(SYSTEM, tools, [
      {
        role: "user",
        content: [
          `Today is ${todayLocal()}.`,
          context ? `What the conversation so far tells you:\n<context>\n${context}\n</context>` : "",
          health ? `Data health, checked just now:\n<data_health>\n${JSON.stringify(health)}\n</data_health>` : "",
          `Question:\n${question}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ])
    const answer = finalAnswer(message)
    if (!answer) {
      throw new Error("Cas ran out of steps before answering; try a narrower question")
    }
    return { answer, toolsUsed: [...new Set(used)] }
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}

/** What Cas can do to the plan from its chat: nothing outside the plan and its to-do list. */
const CHAT_ACTIONS = ["add_plan_action", "set_plan_action_done", "remove_plan_action", "add_upcoming_expense"]

const CHAT_SYSTEM = `You are Cas, the personal financial advisor and accountant for one person or household, talking with them directly in the chat beside their Plan page in their private budgeting app.

The plan: on each payday, money moves into named pots so every bill is funded when it's due, and what's left is theirs to spend. It lands on a goal: a net position (cash less what's owed on cards and revolving credit, home loans left out) by an end date. The plan is always today's data with every pot and one-off adjustment applied, so a change takes effect the moment you make it. There is nothing to rebuild.

How to work:
- Look before you answer. get_plan and get_briefing show where things stand, including the goal's target, forecast and gap; the other read tools answer specific questions. Never estimate what a tool can tell you.
- Test before you act. Run try_plan_change on anything you'd recommend or do, and on every what-if, and quote what it shows. Check that a change doesn't overdraw a cash account or leave a bill uncovered.
- Make the changes they ask for, using upsert_pot, remove_pot, add_plan_adjustment and remove_plan_adjustment. Read planNow in the result and tell them what it did. Their message asking is their confirmation.
- Don't change anything they didn't ask for. When you see something worth changing, say what, with the numbers from try_plan_change, and ask. Decisions in get_plan's unappliedDecisions are already theirs: carry one out when they ask, passing its id in decisionIds.
- When the plan's direction changes enough that its headline or focus list no longer holds, call set_plan_text with new ones. Don't for small changes.
- Add a concrete thing for them to do to the Plan page with add_plan_action, after checking list_plan_actions. Tick off ones that are done.
- You can't change anything else (transactions, categories, budgets, accounts). Say what to do in the app.
- Keep your notes: you only see the last few messages here, so save a note for any decision, preference or fact you'll need in a later conversation, and resolve notes that are done. get_briefing includes the open ones.
- Say plainly when an answer rests on stale or drifted data. You are not a licensed financial adviser; for tax, legal or investment product decisions, give the general picture.
- Pass a fresh operationId with every plan write.

Reply in a few short lines of plain text (short paragraphs or "- " lists, no headings or tables). Lead with the number. Use accounts, bills and pots by name, never by id.`

/** Messages of the chat replayed per turn; Cas's notes carry anything older. */
const CHAT_HISTORY = 12

export type ChatTurn = { role: "user" | "assistant"; content: string }

/**
 * A turn of the Plan page's chat. Cas works through its read and memory tools plus the
 * plan's own action tools, acting as "cas" on the change log. Returns its reply, and the
 * plan to store with it if anything changed: the base plan, with new text if it set some.
 */
export async function planChat(text: string, chat: ChatTurn[], base: Plan | null) {
  let wrote = false
  let revised: Pick<Plan, "summary" | "focus"> | null = null
  const plan = planTools({ deps: () => planDeps("cas"), health: () => loadDataHealth() }).filter(
    (t) => t.access === "action"
  )
  const setText: CasTool = {
    name: "set_plan_text",
    title: "Set the plan's headline",
    access: "action",
    description:
      "Replace the headline summary and focus list the Plan page shows, when a change has outdated them. Give the whole focus list. Takes effect with your reply.",
    input: { summary: PlanSchema.shape.summary, focus: PlanSchema.shape.focus },
    run: async (args) => {
      revised = args as unknown as Pick<Plan, "summary" | "focus">
      return { saved: true }
    },
  }
  const tools = runnable(
    [
      ...TOOLS.filter((t) => t.access !== "action" || CHAT_ACTIONS.includes(t.name)),
      ...plan,
      ...(base ? [setText] : []),
    ],
    (t) => {
      wrote ||= t.access === "action"
    }
  )
  const recent = chat.slice(-CHAT_HISTORY).map(({ role, content }) => ({ role, content }))
  if (recent[0]?.role === "assistant") recent.shift()

  try {
    const health = await loadDataHealth()
    const message = await runAgent(CHAT_SYSTEM, tools, [
      ...recent,
      {
        role: "user",
        content: `Today is ${todayLocal()}.\n\nData health, checked just now:\n<data_health>\n${JSON.stringify(health)}\n</data_health>\n\n${text}`,
      },
    ])
    const reply =
      finalAnswer(message) ||
      (wrote
        ? "I made some changes but ran out of steps before finishing. See Changes to the plan for what went in."
        : "I ran out of steps before answering. Try a narrower question.")
    return { reply, plan: wrote && base ? { ...base, ...(revised ?? {}) } : null }
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}
