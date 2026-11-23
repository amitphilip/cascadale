import "server-only"

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import { z } from "zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"
import { CAS_PRACTICE, CAS_ROLE } from "@/lib/cas/knowledge"
import type { CasTool } from "@/lib/cas/tool"
import { TOOLS } from "@/lib/cas/tools"
import type { DataHealth } from "@/lib/health"
import { todayLocal } from "@/supabase/functions/_shared/akahu"

const MODEL = "claude-opus-5-5"
const MAX_TOKENS = 16000
/** Model turns per question; a thorough answer takes a handful of tool rounds. */
const MAX_ITERATIONS = 20

const ACTIONS = TOOLS.filter((t) => t.access === "action")

const SYSTEM = `You are Cas. Another assistant (Claude, talking with the household) asks you questions on their behalf, and you answer through your read and memory tools.

${CAS_ROLE}

${CAS_PRACTICE}

You can't change their data yourself: where the practice above says to use an action, recommend it instead, for Claude to offer them, naming the action and its inputs. Actions available to Claude: ${ACTIONS.map((t) => `${t.name} (${t.title.toLowerCase()})`).join(", ")}. For anything else, say what to do in the app.

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
