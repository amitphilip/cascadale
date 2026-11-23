"use server"

import { z } from "zod"

import type { ActionResult } from "@/app/actions"
import { getDb, must } from "@/lib/db"

// This device's Web Push subscription, for Cas's messages (see lib/push-client.ts). The
// akahu-sync edge function sends to every subscription in the household.

const subscription = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

export async function savePushSubscription(sub: unknown): Promise<ActionResult<object>> {
  try {
    const { endpoint, keys } = subscription.parse(sub)
    await must(
      (await getDb())
        .from("push_subscriptions")
        .upsert({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: "endpoint" })
    )
    return { ok: true }
  } catch (err) {
    console.error(err)
    return { ok: false, error: err instanceof z.ZodError ? "That browser gave an unusable subscription" : "Couldn't save this device" }
  }
}

export async function removePushSubscription(endpoint: string): Promise<ActionResult<object>> {
  try {
    await must((await getDb()).from("push_subscriptions").delete().eq("endpoint", z.url().parse(endpoint)))
    return { ok: true }
  } catch (err) {
    console.error(err)
    return { ok: false, error: "Couldn't remove this device" }
  }
}
