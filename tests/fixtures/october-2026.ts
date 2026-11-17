import type { HealthInput } from "@/lib/health"
import type { WindowTx } from "@/lib/counted-transactions"

/**
 * A household as it stands on 28 October 2026, made up for the tests (no real data):
 * Mary's fortnightly pay from Wood Partners lands in Joint (its bank description changed in
 * July), the other partner's monthly pay lands in Everyday, Joint repays the home loan every
 * fortnight by transfer, Everyday pays the Visa off every month, and a few monthly bills.
 * Everyday shows 1,082.50 in Cascadale but 1,232.50 at the bank.
 */

export const TODAY = "2026-10-28"
export const NOW = new Date("2026-10-28T09:00:00Z")

export const ACCOUNTS = {
  everyday: { id: 1, name: "Everyday", type: "checking", balance: 1082.5, archived: false },
  joint: { id: 2, name: "Joint", type: "checking", balance: 22945, archived: false },
  streamline: { id: 3, name: "Streamline", type: "savings", balance: 5000, archived: false },
  visa: { id: 4, name: "Visa", type: "credit_card", balance: -1200, archived: false },
  loan: { id: 5, name: "Home loan", type: "loan", balance: -450000, archived: false },
  sharesies: { id: 6, name: "Sharesies", type: "investment", balance: 3000, archived: false },
}

const CATEGORIES = [
  { id: 1, name: "Salary", kind: "income", monthlyBudget: null },
  { id: 2, name: "Power", kind: "expense", monthlyBudget: null },
  { id: 3, name: "Groceries", kind: "expense", monthlyBudget: 1000 },
  { id: 4, name: "Insurance", kind: "expense", monthlyBudget: null },
  { id: 5, name: "Transfer", kind: "transfer", monthlyBudget: null },
  { id: 6, name: "Internet", kind: "expense", monthlyBudget: null },
] as const

const kindOf = (categoryId: number | null) =>
  categoryId === null ? null : CATEGORIES.find((c) => c.id === categoryId)!.kind

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export const MARY_PAY = 3100
export const LOAN_REPAYMENT = 1817.54

export function transactions(): WindowTx[] {
  const out: WindowTx[] = []
  const add = (
    date: string,
    accountId: number,
    description: string,
    amount: number,
    categoryId: number | null,
    ruleId: number | null
  ) =>
    out.push({
      id: out.length + 1,
      date,
      accountId,
      description,
      amount,
      categoryId,
      categoryKind: kindOf(categoryId),
      ruleId,
      ruleNote: null,
    })

  // Mary's pay, every second Wednesday to 14 Oct (next: 28 Oct, 11 Nov). The bank changed
  // its description in July, and a different rule categorizes each spelling.
  for (let k = 13; k >= 0; k--) {
    const date = addDays("2026-10-14", -14 * k)
    const old = date < "2026-07-15"
    add(
      date,
      ACCOUNTS.joint.id,
      old ? "D/C FROM Wood Partners Consu" : "Wood Partners Consu WoodiPayroll41494-0579",
      MARY_PAY,
      1,
      old ? 11 : 12
    )
    // the home loan repayment goes the next day, as a transfer into the loan account
    add(addDays(date, 1), ACCOUNTS.joint.id, "TFR TO HOME LOAN 01", -LOAN_REPAYMENT, 5, 14)
    add(addDays(date, 1), ACCOUNTS.loan.id, "TFR FROM JOINT", LOAN_REPAYMENT, 5, 14)
  }

  for (const month of ["04", "05", "06", "07", "08", "09", "10"]) {
    add(`2026-${month}-15`, ACCOUNTS.everyday.id, "ACME LTD SALARY", 5200, 1, 13)
    add(`2026-${month}-20`, ACCOUNTS.joint.id, "MERCURY ENERGY 123456", -210, 2, 15)
    add(`2026-${month}-05`, ACCOUNTS.joint.id, "ONE NZ BROADBAND", -95, 6, 16)
    add(`2026-${month}-01`, ACCOUNTS.everyday.id, "AA INSURANCE", -180, 4, 17)
    // paying the Visa off: both sides uncategorized, so only pairing tells it's a transfer
    add(`2026-${month}-11`, ACCOUNTS.everyday.id, "TFR TO VISA 4567", -1200, null, null)
    add(`2026-${month}-12`, ACCOUNTS.visa.id, "PAYMENT RECEIVED THANK YOU", 1200, null, null)
  }

  // groceries on the Visa every Saturday
  for (let d = "2026-04-04", i = 0; d <= "2026-10-24"; d = addDays(d, 7), i++)
    add(d, ACCOUNTS.visa.id, "COUNTDOWN AUCKLAND", -(180 + ((i * 37) % 80)), 3, 18)

  // a one-off top-up from Streamline, uncategorized
  add("2026-07-08", ACCOUNTS.streamline.id, "TFR TO JOINT", -500, null, null)
  add("2026-07-08", ACCOUNTS.joint.id, "TFR FROM STREAMLINE", 500, null, null)

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
}

/** What the bank feeds report right now. */
export function healthInput(): HealthInput {
  const synced = { at: "2026-10-28T08:07:00Z", error: null }
  const bank: Record<number, number> = { [ACCOUNTS.everyday.id]: 1232.5 }
  return {
    now: NOW,
    accounts: Object.values(ACCOUNTS),
    feed: {
      connected: true,
      error: null,
      accounts: Object.values(ACCOUNTS).map((a) => ({
        name: a.name,
        linkedTo: a.id,
        balance: bank[a.id] ?? a.balance,
        active: true,
        refreshedAt: "2026-10-28T03:00:00Z",
        lastSync: synced,
      })),
    },
    // a grocery shop minutes ago, not posted yet
    pending: [{ accountId: ACCOUNTS.joint.id, date: TODAY, description: "PAK N SAVE", amount: -45 }],
    posted: [],
    seriesBreaks: [],
  }
}
