import { describe, expect, test } from "vitest"

import { datesBetween, detectRecurringPayments } from "@/lib/planning/recurring-payments"
import { A, ACCOUNTS, AMIT, MAGIC_KINGDOM, NAMES, TODAY, transactions } from "./fixtures/household-november"

const detect = (months: number) =>
  detectRecurringPayments({ txs: transactions(), accounts: ACCOUNTS, names: NAMES, today: TODAY, months })

const find = (payments: ReturnType<typeof detect>, from: number, match: string) =>
  payments.find((p) => p.fromAccountId === from && p.matchKey.includes(match))

describe("detectRecurringPayments", () => {
  const payments = detect(3)

  test("the mortgage: one fortnightly payment from Joint, its parts added up, though only the principal reaches the loans", () => {
    const loan = find(payments, A.joint, "loan repayment")
    expect(loan).toMatchObject({
      kind: "payment",
      name: "Loan Repayment",
      cadence: "fortnightly",
      owner: "Joint",
      typicalAmount: 1683.35,
      confidence: "high",
    })
    expect([A.loan, A.loan2]).toContain(loan!.toAccountId)
    // and not a series per part
    expect(payments.filter((p) => p.fromAccountId === A.joint && p.cadence === "fortnightly")).toHaveLength(1)
  })

  test("daycare at Magic Kingdom: weekly from Joint", () => {
    expect(find(payments, A.joint, "magic kingdom")).toMatchObject({
      kind: "payment",
      cadence: "weekly",
      typicalAmount: MAGIC_KINGDOM,
      owner: "Joint",
      confidence: "high",
    })
  })

  test("Cabin King: weekly from Amit's account, with its next date", () => {
    const cabin = find(payments, A.check, "cabin king")
    expect(cabin).toMatchObject({ cadence: "weekly", typicalAmount: 60, ownerId: AMIT, owner: "Amit" })
    expect(cabin!.nextExpected > cabin!.lastDate).toBe(true)
    expect(cabin!.monthly).toBeCloseTo(260, 0)
  })

  test("AIA fortnightly, Spark and YouTube monthly from Amit's account; Netflix monthly on the card", () => {
    expect(find(payments, A.check, "aia")).toMatchObject({ cadence: "fortnightly", typicalAmount: 140.48 })
    expect(find(payments, A.check, "spark")).toMatchObject({ cadence: "monthly", typicalAmount: 94.99 })
    expect(find(payments, A.check, "youtubepremiumauckland")).toMatchObject({ cadence: "monthly", typicalAmount: 39.99 })
    expect(find(payments, A.card, "netflix")).toMatchObject({ cadence: "monthly", typicalAmount: 25.99 })
  })

  test("credit card payments: a monthly transfer into the card whose amount varies", () => {
    const card = find(payments, A.check, `to:${A.card}`)
    expect(card).toMatchObject({ kind: "transfer", cadence: "monthly", toAccount: "Credit Card", amountVaries: false })
    expect(card!.lastAmount).toBe(1400 + 11 * 37)
  })

  test("transfers between household accounts count: Amit to Joint each pay, Mary to Joint each month", () => {
    expect(find(payments, A.check, `to:${A.joint}`)).toMatchObject({ cadence: "fortnightly", typicalAmount: 2020 })
    expect(find(payments, A.mary, `to:${A.joint}`)).toMatchObject({ cadence: "monthly", typicalAmount: 1577.33, owner: "Mary" })
  })

  test("rates: quarterly from Joint, once there are months enough to see two", () => {
    const quarterly = (m: number) => detect(m).find((p) => p.fromAccountId === A.joint && p.cadence === "quarterly")
    expect(quarterly(3)).toBeUndefined()
    expect(quarterly(6)).toMatchObject({
      typicalAmount: 887.93,
      lastDate: "2026-11-23",
      nextExpected: "2027-02-22",
      count: 2,
      confidence: "low",
      name: "FC12-3456-0000009-00 000001DpsA2AAklCouncil00000000001",
    })
  })

  test("coffee most days and daily round-ups aren't recurring payments", () => {
    expect(find(payments, A.check, "portal cafe")).toBeUndefined()
    expect(payments.some((p) => p.name.toLowerCase().includes("savethechange"))).toBe(false)
  })

  test("a stopped payment drops out", () => {
    const txs = transactions().filter((t) => !(t.description.includes("Cabin King") && t.date > "2026-10-01"))
    const out = detectRecurringPayments({ txs, accounts: ACCOUNTS, names: NAMES, today: TODAY, months: 3 })
    expect(find(out, A.check, "cabin king")).toBeUndefined()
  })
})

describe("datesBetween", () => {
  test("a weekly payment's dates up to the next payday", () => {
    expect(datesBetween({ nextExpected: "2026-11-27", cadence: "weekly" }, TODAY, "2026-12-09")).toEqual([
      "2026-11-27",
      "2026-12-04",
    ])
  })
  test("an overdue one is due today, once", () => {
    expect(datesBetween({ nextExpected: "2026-11-10", cadence: "weekly" }, TODAY, "2026-12-01")).toEqual(["2026-11-26"])
  })
})
