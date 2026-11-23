"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { ActionResult } from "@/app/actions"
import { getDb, must } from "@/lib/db"

// Ticking off an item in the Home inbox (lib/inbox.ts), by its key.

const key = z.string().regex(/^(action|note|nudge):\d+$|^review$/, "Unknown inbox item")

export async function completeInboxItem(itemKey: string): Promise<ActionResult<object>> {
  try {
    const parsed = key.parse(itemKey)
    if (parsed === "review") {
      throw new Error("These clear themselves once the merchants are categorised on the Review page.")
    }
    const [kind, raw] = parsed.split(":")
    const id = Number(raw)
    const db = await getDb()
    const now = new Date().toISOString()
    if (kind === "action") {
      await must(db.from("plan_items").update({ done_at: now }).eq("id", id).eq("kind", "action"))
    } else if (kind === "note") {
      await must(
        db
          .from("cas_notes")
          .update({ resolved_at: now, resolution: "Done: ticked off on Home" })
          .eq("id", id)
          .is("resolved_at", null)
      )
    } else {
      await must(db.from("cas_nudges").update({ done_at: now }).eq("id", id))
    }
    revalidatePath("/", "layout")
    return { ok: true }
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: err.issues.map((i) => i.message).join(", ") }
    console.error(err)
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong" }
  }
}
