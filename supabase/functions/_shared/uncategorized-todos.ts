// Cas to-dos for synced transactions no rule or AI could categorize: one per merchant,
// so Cas asks which category it is. Each sync works out which to-dos should be open and
// the caller writes the difference to cas_notes (ref = UNCATEGORIZED_REF + merchant key).
// A to-do resolves itself once its merchant is categorized.
//
// Shared by the Next.js app and the akahu-sync edge function, so it imports nothing.

export const UNCATEGORIZED_REF = "uncategorized:"
/** Merchants that get a to-do of their own; the rest share one. */
export const MAX_MERCHANT_TODOS = 8
const REST_REF = `${UNCATEGORIZED_REF}*`

export type UncategorizedTx = { description: string; amount: number }
export type RefNote = { id: number; ref: string; content: string }

export type TodoChanges = {
  insert: { ref: string; content: string }[]
  update: { id: number; content: string }[]
  /** open to-dos whose merchants are all categorized now */
  resolve: number[]
}

const txns = (n: number) => `${n} synced ${n === 1 ? "txn" : "txns"}`

function short(description: string) {
  const d = description.replace(/\s+/g, " ").trim()
  return d.length > 40 ? `${d.slice(0, 39)}…` : d
}

/** The to-dos that should be open for these uncategorized transactions, by ref. */
export function uncategorizedTodos(
  rows: UncategorizedTx[],
  keyOf: (description: string) => string,
  money: (n: number) => string
) {
  const groups = new Map<string, { key: string; example: string; count: number; total: number }>()
  for (const r of rows) {
    const key = keyOf(r.description)
    const g = groups.get(key) ?? { key, example: r.description, count: 0, total: 0 }
    g.count++
    g.total += r.amount
    groups.set(key, g)
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.count - a.count || Math.abs(b.total) - Math.abs(a.total) || a.key.localeCompare(b.key)
  )
  // Action — why — how, in one line.
  const todos = new Map<string, string>()
  for (const g of sorted.slice(0, MAX_MERCHANT_TODOS)) {
    todos.set(
      UNCATEGORIZED_REF + g.key,
      `Categorise ${short(g.example)} — ${txns(g.count)} (${money(g.total)}) have no category, so budgets miss them — ask which category, then categorize_merchant "${g.key}".`
    )
  }
  const rest = sorted.slice(MAX_MERCHANT_TODOS)
  if (rest.length > 0) {
    const count = rest.reduce((s, g) => s + g.count, 0)
    const total = rest.reduce((s, g) => s + g.total, 0)
    todos.set(
      REST_REF,
      `Categorise ${rest.length} more merchants — ${txns(count)} (${money(total)}) have no category — go through get_review_queue with them, biggest first.`
    )
  }
  return todos
}

/**
 * What to write to cas_notes: new to-dos, open ones whose numbers changed, and open ones
 * that no longer apply. A to-do resolved without its merchant being categorized (the user
 * said to leave it) isn't raised again until its numbers change.
 */
export function todoChanges(
  wanted: Map<string, string>,
  open: RefNote[],
  resolved: RefNote[]
): TodoChanges {
  const openByRef = new Map(open.map((n) => [n.ref, n]))
  const dismissed = new Set(resolved.map((n) => `${n.ref}\n${n.content}`))
  const changes: TodoChanges = { insert: [], update: [], resolve: [] }
  for (const [ref, content] of wanted) {
    const note = openByRef.get(ref)
    if (note) {
      if (note.content !== content) changes.update.push({ id: note.id, content })
    } else if (!dismissed.has(`${ref}\n${content}`)) {
      changes.insert.push({ ref, content })
    }
  }
  for (const n of open) if (!wanted.has(n.ref)) changes.resolve.push(n.id)
  return changes
}
