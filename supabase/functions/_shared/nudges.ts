// What Cas says without being asked, worked out from the data with no model call, so it's
// quick, free and never makes a number up:
// - payday: a pay landed; here's what the plan moves out of that account this pay.
// - weekly: Monday's check-in on budgets, unbudgeted spending and what's due soon.
// The akahu-sync edge function gathers the inputs, saves the nudge and pushes it.
//
// Shared by the Next.js app's tests and the akahu-sync edge function, so it imports nothing.

export type Every = "week" | "fortnight" | "month" | "once"
export type PayEvery = "week" | "fortnight" | "month"

export type Nudge = {
  kind: "payday" | "weekly"
  dedupeKey: string
  title: string
  /** the inbox's detail: every line */
  body: string
  /** the notification's one line */
  push: string
  dueDate: string | null
}

/** A pay at or above this is worth a payday nudge; smaller income (interest, refunds) isn't. */
export const PAY_MIN = 500

const DAY = 86_400_000
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

/** How often a pay comes, from the last similar one into the same account; null when unknown. */
export function payCadence(date: string, amount: number, earlier: { date: string; amount: number }[]): PayEvery | null {
  const previous = earlier
    .filter((e) => e.date < date && Math.abs(e.amount - amount) <= amount * 0.2)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  if (!previous) return null
  const gap = days(previous.date, date)
  if (gap >= 5 && gap <= 9) return "week"
  if (gap >= 12 && gap <= 16) return "fortnight"
  if (gap >= 26 && gap <= 35) return "month"
  return null
}

const PER_MONTH: Record<PayEvery, number> = { week: 52 / 12, fortnight: 26 / 12, month: 1 }

/** An allocation's amount for one pay that comes every `pay`. */
export function perPay(amount: number, every: PayEvery, pay: PayEvery) {
  if (every === pay) return amount
  return (amount * PER_MONTH[every]) / PER_MONTH[pay]
}

/** Round to a tidy transfer amount: whole dollars, nearest $5 above $100. */
const tidy = (n: number) => (n >= 100 ? Math.round(n / 5) * 5 : Math.round(n))

export type PlanMove = { title: string; amount: number; every: Every; toAccount: string | null; fromAccountId: number | null }

export function paydayNudge(input: {
  pay: { id: number; date: string; amount: number; description: string; accountId: number }
  accountName: string
  cadence: PayEvery | null
  moves: PlanMove[]
  money: (n: number) => string
}): Nudge {
  const { pay, accountName, cadence, money } = input
  const payer = pay.description.replace(/\s+/g, " ").trim().slice(0, 32)
  const title = `${money(pay.amount)} landed in ${accountName}`
  const base = { kind: "payday" as const, dedupeKey: `payday:${pay.id}`, title, dueDate: pay.date }

  const fromHere = input.moves.filter((m) => m.fromAccountId === pay.accountId && m.every !== "once")
  if (fromHere.length === 0) {
    return {
      ...base,
      body: `From ${payer}. The plan doesn't say yet what moves out of ${accountName} on payday. Ask Cas to redo the plan and the next pay will come with a list.`,
      push: `From ${payer}. Open Cascadale to see where it goes.`,
    }
  }
  // without a known cadence, take the plan's own amounts as they are
  const lines = fromHere.map((m) => {
    const amount = tidy(cadence ? perPay(m.amount, m.every as PayEvery, cadence) : m.amount)
    return { amount, text: `${money(amount)} → ${m.toAccount ?? m.title}${m.toAccount && m.toAccount !== m.title ? ` (${m.title})` : ""}` }
  })
  const total = lines.reduce((s, l) => s + l.amount, 0)
  const left = pay.amount - total
  return {
    ...base,
    body: [
      `From ${payer}. The plan moves ${money(total)} of it:`,
      ...lines.map((l) => `• ${l.text}`),
      left >= 0
        ? `That leaves ${money(left)} in ${accountName} for bills and spending.`
        : `That's ${money(-left)} more than the pay; check the plan with Cas.`,
    ].join("\n"),
    push: `Move ${money(total)} in ${lines.length} ${lines.length === 1 ? "transfer" : "transfers"}. Tap for the list.`,
  }
}

export type BudgetLine = { name: string; budget: number; spent: number; period: "week" | "month" }

export function weeklyNudge(input: {
  /** the Monday it's for, yyyy-MM-dd */
  monday: string
  /** share of the month gone, 0..1 */
  monthGone: number
  /** monthly budgets against this month; weekly ones against last week (all of it gone) */
  budgets: BudgetLine[]
  unbudgeted: { name: string; spent: number }[]
  dueSoon: { name: string; total: number; date: string }[]
  todosDue: number
  money: (n: number) => string
  day: (iso: string) => string
}): Nudge | null {
  const { money } = input
  const over = input.budgets
    .filter((b) => b.spent > b.budget)
    .map((b) => ({ ...b, by: b.spent - b.budget }))
    .sort((a, b) => b.by - a.by)
  const ahead = input.budgets
    .filter((b) => b.period === "month" && b.spent <= b.budget && b.spent > b.budget * input.monthGone * 1.1 && b.budget >= 50)
    .sort((a, b) => b.spent / b.budget - a.spent / a.budget)
  const unbudgeted = input.unbudgeted.filter((u) => u.spent >= 20).sort((a, b) => b.spent - a.spent)

  const lines: string[] = []
  if (over.length)
    lines.push(`Over budget: ${over.map((b) => `${b.name} by ${money(b.by)}${b.period === "week" ? " last week" : ""}`).join(", ")}.`)
  if (ahead.length)
    lines.push(`Running ahead: ${ahead.slice(0, 3).map((b) => `${b.name} (${money(b.spent)} of ${money(b.budget)})`).join(", ")}.`)
  if (unbudgeted.length)
    lines.push(`No budget for: ${unbudgeted.slice(0, 3).map((u) => `${u.name} ${money(u.spent)}`).join(", ")} this month.`)
  if (input.dueSoon.length)
    lines.push(`Due in the next two weeks: ${input.dueSoon.map((d) => `${d.name} ${money(d.total)} on ${input.day(d.date)}`).join("; ")}.`)
  if (input.todosDue) lines.push(`${input.todosDue} to-do${input.todosDue === 1 ? "" : "s"} due this week in your inbox.`)

  const onTrack = !over.length && !ahead.length && !unbudgeted.length
  if (onTrack) lines.unshift("Every budget is on pace this month.")

  const push = onTrack
    ? input.dueSoon.length
      ? `On pace. ${input.dueSoon[0].name} ${money(input.dueSoon[0].total)} due ${input.day(input.dueSoon[0].date)}.`
      : "Every budget is on pace. Nothing big due."
    : [
        over.length ? `${over.length} over budget (${over[0].name} by ${money(over[0].by)})` : null,
        unbudgeted.length ? `${money(unbudgeted.reduce((s, u) => s + u.spent, 0))} unbudgeted` : null,
        ahead.length && !over.length ? `${ahead.length} running ahead` : null,
      ]
        .filter(Boolean)
        .join(", ") + "."
  return {
    kind: "weekly",
    dedupeKey: `weekly:${input.monday}`,
    title: "Monday check-in",
    body: lines.join("\n"),
    push,
    dueDate: null,
  }
}
