import type { PaymentAccount, PaymentTx } from "@/lib/planning/recurring-payments"

/**
 * A household on 26 November 2026, made up for the tests but shaped like the real history
 * the planning tools run on: Amit's fortnightly pay lands in his Check account, Mary's
 * monthly pay in hers. From Amit's account: a transfer to Joint each pay, the credit card
 * paid off each month, Cabin King every week, AIA every fortnight, Spark and YouTube
 * monthly, coffee most days and round-ups every day. From Joint: the mortgage in several
 * parts every fortnight (into the home loan account), daycare at Magic Kingdom every week,
 * and council rates every quarter. Netflix goes on the card. Mary sends Joint money for
 * daycare each month.
 */

export const TODAY = "2026-11-26"

export const AMIT = "amit-id"
export const MARY = "mary-id"
export const NAMES = new Map([
  [AMIT, "Amit"],
  [MARY, "Mary"],
])

export const A = { check: 1, joint: 34, card: 35, mary: 67, cabin: 108, loan: 110, loan2: 111, savings: 102 }

export const ACCOUNTS: PaymentAccount[] = [
  { id: A.check, name: "Check Account - Amit", type: "checking", holderId: AMIT },
  { id: A.joint, name: "Check Account - Joint", type: "loan", holderId: null },
  { id: A.card, name: "Credit Card", type: "credit_card", holderId: null },
  { id: A.mary, name: "Check Account - Mary", type: "checking", holderId: MARY },
  { id: A.cabin, name: "Cabin", type: "checking", holderId: null },
  { id: A.loan, name: "Prime Housing Lending", type: "loan", holderId: null },
  { id: A.loan2, name: "Prime Housing Lending", type: "loan", holderId: null },
  { id: A.savings, name: "Everyday Saving", type: "checking", holderId: AMIT },
]

export const CAT = { salary: 1, housing: 4, utilities: 5, dining: 7, insurance: 11, subscriptions: 13, education: 15, transfer: 20 }

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export const AMIT_PAY = 5122.36
export const MAGIC_KINGDOM = 363.6

export function transactions(): PaymentTx[] {
  const out: PaymentTx[] = []
  const add = (date: string, accountId: number, description: string, amount: number, categoryId: number | null) => {
    if (date > TODAY) return
    out.push({ id: out.length + 1, date, accountId, description, amount, categoryId })
  }

  // Amit's pay, every second Wednesday, and what goes from it on payday
  for (let d = "2026-05-06", k = 0; d <= TODAY; d = addDays(d, 14), k++) {
    add(d, A.check, `Wood Partners Consu WoodiPayroll00000-05${60 + k}`, AMIT_PAY, CAT.salary)
    add(d, A.check, "MB TRANSFER TO 12-3456- 0000001-00", -2020, CAT.transfer)
    add(d, A.joint, "MB TRANSFER EX 12-3456- 0000002-00", 2020, CAT.transfer)
    add(d, A.check, "MB TRANSFER TO 12-3456- 0000001-03", -105, CAT.transfer)
    add(d, A.savings, "MB TRANSFER EX 12-3456- 0000002-00", 105, CAT.transfer)
    // AIA every fortnight, the Monday before payday
    add(addDays(d, -2), A.check, "AIA NEW ZEALAND LTD AIANZAIA LIVING", -140.48, CAT.insurance)
    // the mortgage, from Joint the day after Amit's pay, in parts: interest and principal on
    // two loans, and only the principal shows up in each loan account
    const m = addDays(d, 1)
    for (const [part, amount, loan] of [
      ["001INTEREST", 620.44, null],
      ["001PRINCIPAL", 222.63, A.loan],
      ["002INTEREST", 618.39, null],
      ["002PRINCIPAL", 221.89, A.loan2],
    ] as const) {
      add(m, A.joint, `LOAN REPAYMENT 12-3456-0000001-91 ${part}`, -amount, CAT.housing)
      if (loan) add(m, loan, "Principal payment", amount, CAT.housing)
    }
  }

  // every week: Cabin King from Amit's account, daycare from Joint
  for (let d = "2026-05-01"; d <= TODAY; d = addDays(d, 7)) {
    add(d, A.check, "TFR TO Cabin King Example 12 X NL001", -60, CAT.housing)
    add(addDays(d, 5), A.joint, "TFR TO Magic Kingdom Childcare", -MAGIC_KINGDOM, CAT.education)
  }

  for (const month of ["05", "06", "07", "08", "09", "10", "11"]) {
    // Mary's monthly pay, and what she sends Joint for daycare
    add(`2026-${month}-19`, A.mary, "Fph Ltd Nzd", 6070.44, CAT.salary)
    add(`2026-${month}-21`, A.mary, "TFR TO JOINT DAYCARE", -1577.33, CAT.transfer)
    add(`2026-${month}-21`, A.joint, "EXAMPLE,MARY Daycare", 1577.33, CAT.transfer)
    // Spark broadband and YouTube from Amit's account, Netflix on the card
    add(`2026-${month}-08`, A.check, "SPARK NZ TRADING LTD 4471232", -94.99, CAT.utilities)
    add(`2026-${month}-22`, A.check, "CARD 0785 Google YouTubePremiumAuckland", -39.99, CAT.subscriptions)
    add(`2026-${month}-14`, A.card, "NETFLIX.COM AUCKLAND", -25.99, CAT.subscriptions)
    // paying the card off from Amit's account, a different amount each month
    const owed = 1400 + Number(month) * 37
    add(`2026-${month}-11`, A.check, "MB TRANSFER TO CARD 2699THANK YOU", -owed, CAT.transfer)
    add(`2026-${month}-12`, A.card, "PAYMENT RECEIVED THANK YOU", owed, CAT.transfer)
  }

  // Auckland Council rates, quarterly from Joint
  for (const d of ["2026-05-23", "2026-08-23", "2026-11-23"]) {
    add(d, A.joint, "FC12-3456-0000009-00 000001DpsA2AAklCouncil00000000001", -887.93, CAT.housing)
  }

  // coffee most weekdays and round-ups every day: frequent, but not on a cadence
  for (let d = "2026-08-01", i = 0; d <= TODAY; d = addDays(d, 1), i++) {
    if (i % 7 < 5) add(d, A.check, "CARD 2765 Portal Cafe Auckland", -(5.2 + (i % 3) * 0.5), CAT.dining)
    add(d, A.check, `SAVETHECHANGE ${d}`, -(0.1 + (i % 9) / 10), CAT.transfer)
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
}

/** The decision note the household saved about the school fees, as it reads in Cascadale. */
export const SCHOOL_FEES_NOTE = {
  id: 42,
  kind: "decision",
  content:
    "Mary pays the school fees, and always has. Amit's pay covers his share of the mortgage only.",
  subject: null,
  payerMemberId: null,
}
