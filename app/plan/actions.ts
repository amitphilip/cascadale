"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { ActionResult } from "@/app/actions"
import { getDb, must } from "@/lib/db"

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
