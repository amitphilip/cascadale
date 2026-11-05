import "server-only"

import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod"

import { anthropicClient } from "@/lib/anthropic"
import { describeError } from "@/lib/categorize"

import { JUDGE_SYSTEM, JudgementSchema, type Judge } from "./judge"

const MAX_TOKENS = 16000

/** Haiku has no server-side refusal fallback; the larger models fall back by default. */
const fallbackFor = (model: string) =>
  model.startsWith("claude-haiku")
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }

/** The judge on Claude, through the household's Anthropic key. */
export const claudeJudge: Judge = async (input, model) => {
  const client = await anthropicClient()
  const started = Date.now()
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      ...fallbackFor(model),
      thinking: { type: "adaptive" },
      output_config: {
        effort: model.startsWith("claude-haiku") ? "medium" : "high",
        format: betaZodOutputFormat(JudgementSchema),
      },
      system: [{ type: "text", text: JUDGE_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `<state>\n${JSON.stringify(input)}\n</state>` }],
    })
    const response = await stream.finalMessage()
    if (response.stop_reason === "refusal") throw new Error("The model declined to judge this run")
    if (response.stop_reason === "max_tokens") throw new Error("The model's judgement was cut off")
    if (!response.parsed_output) throw new Error("The model returned a malformed judgement")
    return {
      judgement: response.parsed_output,
      model: response.model,
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      latencyMs: Date.now() - started,
    }
  } catch (err) {
    console.error(err)
    throw new Error(describeError(err))
  }
}
