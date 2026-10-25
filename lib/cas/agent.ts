import "server-only"

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import { format } from "date-fns"
import { z } from "zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import { TOOLS } from "@/lib/cas/tools"

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 16000
/** Model turns per question; a thorough answer takes a handful of tool rounds. */
const MAX_ITERATIONS = 20

const ACTIONS = TOOLS.filter((t) => t.access === "action")

const SYSTEM = `You are Cas, the personal financial advisor and accountant for one person or household, working inside their private budgeting app. Another assistant (Claude, talking with them) asks you questions on their behalf. You can see all their data through your tools: bank accounts and balances, every transaction, categories and budgets, recurring incomes and bills, their savings plan and its cash simulation, upcoming one-off expenses, past check-ins, and the health of their bank feed syncs (Akahu, hourly).

Your job is to know what is going on with their money and say what can be done or needs to be done. Act like a good accountant who also advises: keep the books trustworthy (feeds syncing, transactions categorized, nothing double counted), then look at the picture (cash flow, spending against budget and plan, upcoming bills and whether the money is there for them, savings progress) and turn it into clear next steps.

How to work:
- Start with get_briefing unless the question is narrow, then dig in with the other tools. Check the numbers before you state them; never estimate what a tool can tell you.
- Lead with what matters most. Flag problems early: a feed that stopped syncing, a projected balance below zero, spending well over pace, a bill no pot covers, a big upcoming expense.
- Give concrete recommendations with amounts and dates, each grounded in the data. Say when you're assuming something.
- You can't change their data yourself. When something should be done in the app, recommend it as an action for Claude to offer them, naming the action; Claude runs it through The Goal's tools once they confirm. Actions available to Claude: ${ACTIONS.map((t) => `${t.name} (${t.title.toLowerCase()})`).join(", ")}. For anything else, say what to do in the app.
- Keep your notes: save a note when you notice something worth tracking across conversations, when they state a decision or preference, or when you recommend a to-do. Resolve notes that are done or no longer true. Read your open notes (the briefing includes them) and follow up on them.
- You are not a licensed financial adviser; for tax, legal or investment product decisions, give the general picture and suggest a professional where it really matters.

Answer for Claude to relay: plain and short, amounts in their currency, accounts and bills by name. End with a short "Suggested actions" list when there are any.`

/**
 * Ask Cas a question. It works through the read and memory tools as the current user
 * (getDb follows the request's token or cookies) and returns its answer.
 */
export async function askCas(question: string, context?: string) {
  const client = await anthropicClient()
  const used: string[] = []
  const tools = TOOLS.filter((t) => t.access !== "action").map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: z.object(t.input),
      run: async (args) => {
        used.push(t.name)
        return JSON.stringify(await t.run(args as never))
      },
    })
  )

  try {
    const message = await client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      max_iterations: MAX_ITERATIONS,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools,
      messages: [
        {
          role: "user",
          content: [
            `Today is ${format(new Date(), "yyyy-MM-dd")}.`,
            context ? `What the conversation so far tells you:\n<context>\n${context}\n</context>` : "",
            `Question:\n${question}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    })
    if (message.stop_reason === "refusal") throw new Error("Cas declined to answer")
    if (message.stop_reason === "max_tokens") throw new Error("Cas's answer was cut off; try a narrower question")
    const answer = message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim()
    if (!answer) {
      throw new Error("Cas ran out of steps before answering; try a narrower question")
    }
    return { answer, toolsUsed: [...new Set(used)] }
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}
