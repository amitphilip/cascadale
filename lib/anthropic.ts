import "server-only"

import Anthropic from "@anthropic-ai/sdk"

import { getDb, must } from "@/lib/db"

export const API_KEY_SETTING = "anthropicApiKey"

async function savedKey() {
  const [row] = await must<{ value: string }[]>(
    (await getDb()).from("settings").select("value").eq("key", API_KEY_SETTING)
  )
  return row?.value
}

/** The key saved in Settings, else ANTHROPIC_API_KEY from the environment. */
export async function getApiKey() {
  return (await savedKey()) || process.env.ANTHROPIC_API_KEY || null
}

export async function anthropicClient() {
  const apiKey = await getApiKey()
  if (!apiKey) throw new Error("Add your Anthropic API key in Settings to use AI features")
  return new Anthropic({ apiKey })
}

/** What Settings shows about the key, without ever sending it to the browser. */
export async function getApiKeyStatus() {
  const saved = await savedKey()
  const key = saved || process.env.ANTHROPIC_API_KEY
  if (!key) return null
  return { source: saved ? ("settings" as const) : ("env" as const), hint: key.slice(-4) }
}

export type ApiKeyStatus = Awaited<ReturnType<typeof getApiKeyStatus>>
