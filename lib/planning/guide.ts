import "server-only"

import { getDb, must } from "@/lib/db"
import { getPeople } from "@/lib/queries"
import { loadPlanInputs } from "@/lib/plan-inputs"
import { householdAccounts, openNotes, standingRules } from "@/lib/planning/data"

// The system guide: a markdown document that explains Cascadale to Claude. The household's
// facts (members, pay schedules, accounts, standing rules) are read live each time; the rest
// (what the concepts mean, how cycles work, the order of planning, the rules Claude keeps)
// is kept in settings under GUIDE_SETTING so it can be edited with update_system_guide, and
// falls back to DEFAULT_GUIDE.

export const GUIDE_SETTING = "systemGuide"

export const DEFAULT_GUIDE = `## What things mean

- **Plan item** (a plan move): one line of the household's long-term plan. It says how much (amount), how often (every: week, fortnight, month, or once), from whose pay (fromMemberId) and which account (fromAccountId), into which account (toAccountId, or none when the money leaves the household), and what it's for (purpose: bills, budget, one_off, savings, goal, buffer or debt). A move is a plan item that leaves a member's account by hand on payday. Items can start and end (startDate, endDate), carry a target (savings, debt, one-off), and name what pays them (matchKeys: merchant keys, or "to:<accountId>" for a transfer) so plan_vs_actual can check them.
- **The plan** is shared by the household. It changes only through pending changes that a member approves. Removed items are kept as history (get_plan_history).
- **Short-term allocation**: one member's actual transfers for this pay cycle, on top of the plan. A line with planItemId overrides that plan move's amount for this pay (0 skips it); a free line is a move the plan doesn't name, to a household account (toAccountId) or out of the household (match: the merchant key its transactions carry). Each member has their own. It goes stale when a sync brings in a new pay or move; set_short_term clears that.
- **One-off**: a known cost coming up (a trip, rates, a fee, a purchase): a total gathered in an account and paid out by a finish date, in one go or in parts. Only linked transactions count towards it.
- **Budget**: a category's spending limit, weekly (Monday to Sunday) or monthly, as an amount or a percent of projected monthly income. Budgets are the household's.
- **Note**: what Claude and the household remember between conversations: observations, decisions, preferences and to-dos. A decision about who pays for something (with subject and payerMemberId, or worded "<name> pays <subject>") is a standing rule: plan items that break it are rejected unless override is passed.
- **Recurring payment**: money that goes out of an account on a weekly, fortnightly, monthly or quarterly cadence, found from the transactions (detect_recurring_payments). Transfers between household accounts count, keyed by the account they go into.

## How pay cycles work

Each member's cycle runs from the day their main pay (their largest regular income) lands to the day before the next one is due: fortnightly or monthly, whatever their pay is. It moves on by itself each payday; while a pay is late the cycle stays open. Without a regular pay it's the calendar month. Plan moves on the pay's own cadence are due in full from payday; others are spread over the cycle. cycle_position shows where a member is: pay in, moves done and still to make, bills due before the next payday, and what's left in the pay account.

## Order of operations for planning

Run this for each member, on a schedule or when asked:

1. Check the data: get_sync_status / get_briefing's data_health. Stale feeds or drift mean the numbers can't be trusted yet: say so and stop short of changing anything.
2. Read this guide (get_system_guide) and the open notes (get_notes). Follow the standing rules.
3. cycle_position for the member: where the pay cycle stands.
4. detect_recurring_payments and plan_vs_actual: what really goes out, and where the plan disagrees (amounts over 5% apart, the wrong payer, a standing rule broken, recurring payments with no plan item).
5. credit_card_due: what each card owes and when it's usually paid.
6. Fix this pay: preview_short_term with the lines it needs (card payment, skipped or reduced moves, money still to move), check nothing's uncovered, then set_short_term with a reason.
7. Propose long-term fixes: upsert_plan_item / remove_plan_item make pending changes with a reason. Don't approve them yourself.
8. Save a note for anything that should hold beyond this pay, and say what you changed and what's waiting for approval.

## Rules for Claude

- Answer affordability questions with the numbers: what's left, what slips and by how much. Use what_if, give its verdict (yes, yes if, or no) with the deciding number, then the options.
- Short-term changes can be applied once the person says yes (set_short_term, or commit_purchase with an option that only touches this pay).
- Long-term changes always go through a pending change. A member approves it (approve_change, as themselves); never approve a change on your own, and never in a scheduled run.
- Don't bring in the other person's spending unless the question needs it. Shared costs (joint accounts, the mortgage, daycare) are fair to mention.
- Every plan and short-term write needs a reason, in the household's words where they gave one.
- Check the numbers with the tools before stating them; never estimate what a tool can tell you. Say when an answer rests on stale data or a low-confidence assumption.
- Cascadale plans and records transfers. People make them in their banking app: say what to move, from where, to where.`

/** The editable part of the guide: what's saved, else the default. */
export async function getGuideText() {
  const [row] = await must<{ value: string }[]>((await getDb()).from("settings").select("value").eq("key", GUIDE_SETTING))
  return { text: row?.value?.trim() || DEFAULT_GUIDE, customised: Boolean(row?.value?.trim()) }
}

/** Save the editable part of the guide; null goes back to the default. */
export async function saveGuideText(text: string | null) {
  const db = await getDb()
  if (text === null || !text.trim()) {
    await must(db.from("settings").delete().eq("key", GUIDE_SETTING))
    return { customised: false }
  }
  await must(db.from("settings").upsert({ key: GUIDE_SETTING, value: text.trim() }, { onConflict: "user_id,key" }))
  return { customised: true }
}

const money = (n: number) => n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** The whole guide: the household's facts, read live, then the editable part. */
export async function buildSystemGuide() {
  const [{ text, customised }, people, accounts, inputs, rules, notes] = await Promise.all([
    getGuideText(),
    getPeople(),
    householdAccounts(),
    loadPlanInputs(),
    standingRules(),
    openNotes(),
  ])
  const holder = new Map(accounts.map((a) => [a.id, a.holderId]))
  const pays = (inputs?.incomeSources ?? []).filter((s) => s.cadence !== "Irregular" && s.amount >= 100)

  const members = people.map((p) => {
    const theirs = pays.filter((s) => s.accountId !== null && holder.get(s.accountId) === p.id)
    const lines = theirs.length
      ? theirs.map((s) => `  - ${s.name}: ${money(s.amount)} ${s.cadence.toLowerCase()}, into ${s.account} (account ${s.accountId}); last ${s.lastDate}, next ${s.nextDate}`)
      : ["  - No regular pay found into their accounts"]
    return [`- **${p.name}** (memberId ${p.id})${p.isOwner ? ", the household's owner" : ""}`, ...lines].join("\n")
  })
  const otherPays = pays.filter((s) => s.accountId === null || holder.get(s.accountId) == null)

  const accountRows = accounts
    .filter((a) => !a.archived)
    .map((a) => `| ${a.id} | ${a.name} | ${a.type} | ${a.owner} | ${a.purpose ?? "_not set_"} | ${money(a.balance)} |`)

  const decisionNotes = notes.filter((n) => n.kind === "decision" || n.kind === "preference")
  const ruleLines = rules.map((r) => `- **${r.payer} pays ${r.subject}** (note ${r.noteId}): ${r.content}`)
  const otherDecisions = decisionNotes
    .filter((n) => !rules.some((r) => r.noteId === n.id))
    .map((n) => `- (${n.kind}, note ${n.id}) ${n.content}`)

  const markdown = `# Cascadale: a guide for Claude

Cascadale is this household's budgeting app: bank accounts synced hourly from Akahu, transactions, categories and budgets, recurring payments, one-offs, a shared plan, each member's short-term allocation for their pay, and notes. Cascadale keeps the data, the rules and the figures; Claude makes the judgement calls through these tools. Amounts are in ${inputs?.currency ?? "the household's currency"}.

## Household members and their pay

${members.join("\n")}
${otherPays.length ? `\nRegular income into joint accounts: ${otherPays.map((s) => `${s.name} ${money(s.amount)} ${s.cadence.toLowerCase()} into ${s.account ?? "an unknown account"}`).join("; ")}.\n` : ""}
## Accounts

| id | name | type | owner | purpose | balance |
|---|---|---|---|---|---|
${accountRows.join("\n")}

An account's purpose is set with set_account_purpose. Joint accounts belong to both members.

## Standing rules

${ruleLines.length ? ruleLines.join("\n") : "- None about who pays for what yet."}
${otherDecisions.length ? `\nOther decisions and preferences:\n${otherDecisions.join("\n")}` : ""}

${text}
`
  return { markdown, customised, editable: text }
}
