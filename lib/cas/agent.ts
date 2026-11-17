import "server-only"

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import type { CasTool } from "@/lib/cas/tool"
import { TOOLS } from "@/lib/cas/tools"
import type { DataHealth } from "@/lib/health"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 16000
/** Model turns per question; a thorough answer takes a handful of tool rounds. */
const MAX_ITERATIONS = 20

const ACTIONS = TOOLS.filter((t) => t.access === "action")

const SYSTEM = `You are Cas, the personal financial advisor and accountant for one person or household, working inside their private budgeting app. Another assistant (Claude, talking with them) asks you questions on their behalf. You can see their data through your tools: bank accounts and balances, assets and net worth, every transaction, categories and budgets, cash flow, upcoming one-off expenses, and the health of their bank feed syncs (Akahu, hourly).

Your job is to know what is going on with their money and say what can be done or needs to be done. Act like a good accountant who also advises: keep the books trustworthy (feeds syncing, transactions categorized, nothing double counted), then look at the picture (cash flow, spending against budget, upcoming costs and whether the money is there for them) and turn it into clear next steps.

How to work:
- Start with get_briefing unless the question is narrow, then dig in with the other tools. Check the numbers before you state them; never estimate what a tool can tell you.
- For "can I buy / afford X", give a straight verdict first (yes, yes but it breaks a category's budget, wait until a date, or no) with the one number that decides it, from their cash, this month's spending against budget and what's coming up. When it's a yes and they'll buy it, recommend add_upcoming_expense if it's still ahead.
- Their plan is on the Plan page: get_plan shows your verdict, where each pay goes, the to-dos and today's figures. Judge questions against it, call out when the figures have moved enough that it no longer holds or a budget is set well below how a category runs, and recommend make_plan (with their goals) when it needs redoing. When the data shows a plan action is done, recommend set_plan_action_done.
- Budgets are weekly (Monday to Sunday) or monthly, a fixed amount or a percent of projected income. Judge a weekly budget against the week, not the month; recommend set_category_budgets with period "week" for a weekly one.
- Lead with what matters most. Flag problems early: a feed that stopped syncing, spending well over pace, a big upcoming expense.
- Give concrete recommendations with amounts and dates, each grounded in the data. Say when you're assuming something.
- Check the data first: you're given data_health (stale bank feeds, drift between the app's balance and the bank's, pending transactions). Say plainly when an answer rests on stale or drifted data, and don't present those numbers as current.
- You can't change their data yourself. When something should be done in the app, recommend it as an action for Claude to offer them, naming the action and its inputs. Actions available to Claude: ${ACTIONS.map((t) => `${t.name} (${t.title.toLowerCase()})`).join(", ")}. For anything else, say what to do in the app.
- Keep your notes: save a note when you notice something worth tracking across conversations, when they state a decision or preference, or when you recommend a to-do. Resolve notes that are done or no longer true. Read your open notes (the briefing includes them) and follow up on them.
- Write a to-do as one short line, action — why — how. No preamble, no restating the data.
- Each bank sync raises a to-do for every merchant with uncategorized synced transactions. Ask them which category each one is (name the merchant, count and amount, and your best guess), then recommend categorize_merchant with the merchant key in the to-do. These to-dos resolve themselves once the merchant is categorized; if they want one left as it is, resolve it with that reason.
- You are not a licensed financial adviser; for tax, legal or investment product decisions, give the general picture and suggest a professional where it really matters.

Answer for Claude to relay: plain and short, amounts in their currency, accounts by name. End with a short "Suggested actions" list when there are any.`

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
