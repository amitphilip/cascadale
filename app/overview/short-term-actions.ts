"use server"

import { revalidatePath } from "next/cache"

import { refreshShortTerm } from "@/lib/cas/short-term"

/**
 * Have Cas look at this pay's transfers again, when a sync has brought in something since it
 * last did. Home calls it when it shows a short-term allocation that's out of date.
 */
export async function refreshShortTermAction(): Promise<{ ok: true; looked: boolean } | { ok: false; error: string }> {
  try {
    const out = await refreshShortTerm()
    if (out?.looked) revalidatePath("/overview")
    return { ok: true, looked: out?.looked ?? false }
  } catch (err) {
    console.error(err)
    return { ok: false, error: err instanceof Error ? err.message : "Cas couldn't look at this pay" }
  }
}
