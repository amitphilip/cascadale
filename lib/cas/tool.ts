import { z } from "zod"

/**
 * - read: only reads; on Cascadale's MCP server and for the agent
 * - memory: reads or writes Cas's own notes; for the agent (the Cas MCP server
 *   shows them too)
 * - action: changes your data; only on Cascadale's MCP server, so you confirm each one
 */
export type ToolAccess = "read" | "memory" | "action"

export type CasTool = {
  name: string
  title: string
  description: string
  access: ToolAccess
  input: z.ZodRawShape
  run: (args: never) => Promise<unknown>
}

export function tool<S extends z.ZodRawShape = Record<string, never>>(t: {
  name: string
  title: string
  description: string
  access: ToolAccess
  input?: S
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>
}): CasTool {
  return { ...t, input: t.input ?? {} }
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-MM-dd")

/** Starts the description of every tool that changes real data. */
export const CHANGES_DATA = "CHANGES REAL DATA (confirm with the user first)."

/**
 * A tool's result with the household's currency and locale on it, so every MCP response
 * says what its amounts are in. Objects get the fields alongside theirs; anything else
 * goes under result.
 */
export function withMoney(value: unknown, money: { currency: string; locale: string }) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { currency: money.currency, locale: money.locale, ...value }
    : { currency: money.currency, locale: money.locale, result: value }
}
