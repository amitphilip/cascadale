import { redirect } from "next/navigation"

import { latestPlan } from "@/lib/planner"
import { getPlanThread } from "@/lib/queries"

/** Home is the plan once there is one; until then the overview walks you through setup. */
export default async function HomePage() {
  const thread = await getPlanThread()
  redirect(thread && latestPlan(thread.messages) ? "/plan" : "/overview")
}
