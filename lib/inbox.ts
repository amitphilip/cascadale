import "server-only"

import { subDays } from "date-fns"

import { COLUMNS, getDb, must } from "@/lib/db"
import type { CasNudge } from "@/lib/db/schema"
import { getCurrentPlan } from "@/lib/plan-data"
import { getOpenCasNotes } from "@/lib/queries"
import { UNCATEGORIZED_REF } from "@/supabase/functions/_shared/uncategorized-todos"

// One inbox for everything that needs you: the plan's to-do actions, Cas's to-dos, and the
// messages Cas sends on its own (a pay landed, the Monday check-in). Home shows it; ticking
// one off goes through completeInboxItem (app/inbox-actions.ts) by its key.

export type InboxItem = {
  /** "action:<plan item id>", "note:<cas note id>", "nudge:<nudge id>" or "review" */
  key: string
  source: "plan" | "cas" | "nudge"
  title: string
  detail: string | null
  /** yyyy-MM-dd */
  dueDate: string | null
  /** ISO */
  createdAt: string
  /** where to act on it in the app, if anywhere */
  href: string | null
}

/** Nudges older than this drop out of the inbox even if never ticked off: they've passed. */
const NUDGE_DAYS = 10

/** Cas writes to-dos as "action — why — how": the action is the title, the rest the detail. */
function split(content: string) {
  const [title, ...rest] = content.split(" — ")
  return { title: title.trim(), detail: rest.length ? rest.join(" — ").trim() : null }
}

export async function getInbox(): Promise<InboxItem[]> {
  const db = await getDb()
  const since = subDays(new Date(), NUDGE_DAYS).toISOString()
  const [plan, notes, nudges] = await Promise.all([
    getCurrentPlan(),
    getOpenCasNotes(100),
    must<CasNudge[]>(
      db
        .from("cas_nudges")
        .select(COLUMNS.casNudges)
        .is("done_at", null)
        .gte("created_at", since)
        .order("id", { ascending: false })
    ),
  ])

  const items: InboxItem[] = []
  for (const n of nudges) {
    items.push({
      key: `nudge:${n.id}`,
      source: "nudge",
      title: n.title,
      detail: n.body,
      dueDate: n.dueDate,
      createdAt: n.createdAt,
      href: n.kind === "payday" ? "/plan" : null,
    })
  }
  for (const a of plan?.actions ?? []) {
    if (a.doneAt) continue
    items.push({
      key: `action:${a.id}`,
      source: "plan",
      title: a.title,
      detail: a.detail,
      dueDate: a.dueDate,
      createdAt: plan!.plan.createdAt,
      href: "/plan",
    })
  }

  // The sync raises a to-do per uncategorized merchant, written for Cas; here they're one item.
  const todos = notes.filter((n) => n.kind === "todo")
  const uncategorized = todos.filter((n) => n.ref?.startsWith(UNCATEGORIZED_REF))
  for (const n of todos) {
    if (n.ref?.startsWith(UNCATEGORIZED_REF)) continue
    items.push({ key: `note:${n.id}`, source: "cas", ...split(n.content), dueDate: n.dueDate, createdAt: n.createdAt, href: null })
  }
  if (uncategorized.length) {
    items.push({
      key: "review",
      source: "cas",
      title:
        uncategorized.length === 1 ? "Categorise a merchant" : `Categorise ${uncategorized.length} merchants`,
      detail: "Synced transactions with no category, so budgets miss them.",
      dueDate: null,
      createdAt: uncategorized[0].createdAt,
      href: "/review",
    })
  }

  // Nudges first (newest first), then whatever's due soonest, then the rest newest first.
  const rank = (i: InboxItem) => (i.source === "nudge" ? 0 : i.dueDate ? 1 : 2)
  return items.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dueDate && b.dueDate ? a.dueDate.localeCompare(b.dueDate) : 0) ||
      b.createdAt.localeCompare(a.createdAt)
  )
}
