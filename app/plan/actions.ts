"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { ActionResult } from "@/app/actions"
import { makePlan } from "@/lib/cas/plan"
import { getDb, must } from "@/lib/db"
import { CAS_DISABLED_MESSAGE, casEnabled } from "@/lib/flags"

// The Plan page's actions, acting as the signed-in user like those in app/actions.ts.

async function run<T extends object>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const out = await fn()
    revalidatePath("/", "layout")
    return { ok: true, ...out }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.issues.map((i) => i.message).join(", ") }
    }
    console.error(err)
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong" }
  }
}

const id = z.coerce.number().int().positive()

/** Ask Cas for a new plan from today's data and these goals. Takes a minute or so. */
export async function askCasForPlan(goals: string) {
  return run(async () => {
    if (!casEnabled()) throw new Error(CAS_DISABLED_MESSAGE)
    const text = z.string().trim().max(2000, "Keep your goals under 2,000 characters").parse(goals)
    const { planId } = await makePlan(text || null, "website")
    return { planId }
  })
}

/** Tick a plan action off, or reopen it. */
export async function setPlanItemDone(itemId: number, done: boolean) {
  return run(async () => {
    await must(
      (await getDb())
        .from("plan_items")
        .update({ done_at: done ? new Date().toISOString() : null })
        .eq("id", id.parse(itemId))
    )
    return {}
  })
}
