import { describe, expect, test } from "vitest"

import { mentions, payerConflicts, payerRules, planVsActual, type CheckedItem } from "@/lib/planning/plan-check"
import { detectRecurringPayments } from "@/lib/planning/recurring-payments"
import { A, ACCOUNTS, AMIT, CAT, MARY, NAMES, SCHOOL_FEES_NOTE, TODAY, transactions } from "./fixtures/household-november"

const members = [
  { id: AMIT, name: "Amit" },
  { id: MARY, name: "Mary" },
]
const holder = new Map(ACCOUNTS.map((a) => [a.id, a.holderId]))
const holderOf = (id: number) => holder.get(id) ?? null
const nameOf = (id: string | null) => (id === null ? "Joint" : (NAMES.get(id) ?? "Someone"))

const payments = detectRecurringPayments({ txs: transactions(), accounts: ACCOUNTS, names: NAMES, today: TODAY, months: 3 })

const item = (i: Partial<CheckedItem> & { id: number; title: string }): CheckedItem & { id: number } => ({
  detail: null,
  notes: null,
  purpose: "bills",
  amount: null,
  every: "month",
  categoryId: null,
  accountId: null,
  fromAccountId: null,
  fromMemberId: null,
  matchKeys: [],
  ...i,
})

// the household's plan as it stood on 26 November
const PLAN = [
  item({
    id: 110,
    title: "Mortgage and school fees",
    detail: "Covers the $1,817 fortnightly loan repayment and $364 weekly school transfer, both paid from Joint.",
    amount: 2555,
    every: "fortnight",
    accountId: A.joint,
    fromAccountId: A.check,
    fromMemberId: AMIT,
  }),
  item({ id: 111, title: "Cabin King", detail: "Covers the $60 weekly Cabin King transfer.", amount: 130, every: "fortnight", categoryId: CAT.housing, accountId: A.cabin, fromAccountId: A.check, fromMemberId: AMIT }),
  item({ id: 112, title: "Utilities", detail: "Mercury, Watercare and Spark.", amount: 95, every: "month", categoryId: CAT.utilities, accountId: A.check }),
  // planned as if AIA came monthly
  item({ id: 113, title: "Insurance", detail: "AIA, Southern Cross and AMI.", amount: 140.48, every: "month", categoryId: CAT.insurance, accountId: A.check }),
  item({ id: 130, title: "Everyday Saving", purpose: "savings", amount: 105, every: "fortnight", accountId: A.savings, fromAccountId: A.check, fromMemberId: AMIT }),
]

describe("payerRules", () => {
  test("reads who pays from a decision note's words", () => {
    expect(payerRules([SCHOOL_FEES_NOTE], members)).toEqual([
      { noteId: 42, subject: "school fees", payerId: MARY, payer: "Mary", content: SCHOOL_FEES_NOTE.content },
    ])
  })

  test("a note's own subject and payer win", () => {
    const note = { id: 7, kind: "decision", content: "Daycare is on Mary", subject: "daycare", payerMemberId: MARY }
    expect(payerRules([note], members)[0]).toMatchObject({ subject: "daycare", payer: "Mary" })
  })

  test("observations and to-dos aren't rules", () => {
    expect(payerRules([{ ...SCHOOL_FEES_NOTE, kind: "observation" }], members)).toEqual([])
  })

  test("mentions matches plurals and case", () => {
    expect(mentions("Mortgage and School Fee", "school fees")).toBe(true)
    expect(mentions("Mortgage", "school fees")).toBe(false)
  })
})

describe("planVsActual", () => {
  const rules = payerRules([SCHOOL_FEES_NOTE], members)
  const out = planVsActual({ items: PLAN, payments, categorySpend: new Map(), rules, holderOf, nameOf })
  const byId = (id: number) => out.items.find((i) => i.planItemId === id)!

  test("flags the school fees on Amit's Mortgage and school fees move, since Mary pays them", () => {
    const m = byId(110)
    expect(m.plannedPayer).toBe("Amit")
    expect(m.noteConflicts).toEqual([
      expect.objectContaining({ noteId: 42, subject: "school fees", payer: "Mary", plannedPayer: "Amit" }),
    ])
    expect(m.flags.some((f) => f.includes("decision note says Mary pays it"))).toBe(true)
  })

  test("and the move itself is $2,020 a pay against $2,555 planned: over 5% apart", () => {
    const m = byId(110)
    expect(m.matched.map((x) => x.matchedBy)).toEqual(["transfer"])
    expect(m.actualMonthly).toBeCloseTo((2020 * 26) / 12, 2)
    expect(m.mismatch).toBe(true)
    expect(m.difference).toBeCloseTo(2020 / 2555 - 1, 2)
  })

  test("Cabin King matches by name, not by its Housing category (which the mortgage shares)", () => {
    const m = byId(111)
    expect(m.matched.map((x) => [x.name, x.matchedBy])).toEqual([["Cabin King Example", "name"]])
    expect(m.actualMonthly).toBeCloseTo((60 * 52) / 12, 2)
    expect(m.mismatch).toBe(true)
  })

  test("bills paid as planned, by who the plan says, aren't flagged", () => {
    expect(byId(112)).toMatchObject({ mismatch: false, paidByOther: false, noteConflicts: [] })
    expect(byId(112).matched.map((x) => x.name)).toEqual(["Spark Nz Trading"])
    expect(byId(130)).toMatchObject({ mismatch: false, flags: [] })
  })

  test("AIA comes $140.48 a fortnight, not a month: flagged", () => {
    expect(byId(113)).toMatchObject({ mismatch: true, actualPayers: ["Amit"] })
    expect(byId(113).actualMonthly).toBeCloseTo((140.48 * 26) / 12, 2)
  })

  test("recurring payments no plan item covers are listed", () => {
    const names = out.unplanned.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(["Magic Kingdom Childcare", "Transfer to Credit Card", "Loan Repayment"]))
    expect(names).not.toContain("Spark Nz Trading")
  })

  test("a plan item paid by someone else is flagged", () => {
    const mary = planVsActual({
      items: [item({ id: 200, title: "Spark", amount: 94.99, accountId: A.mary, fromMemberId: MARY })],
      payments,
      categorySpend: new Map(),
      rules: [],
      holderOf,
      nameOf,
    })
    expect(mary.items[0]).toMatchObject({ paidByOther: true, actualPayers: ["Amit"], plannedPayer: "Mary" })
  })

  test("matchKeys tie a payment to an item exactly", () => {
    const fees = planVsActual({
      items: [item({ id: 300, title: "Daycare", amount: 363.6, every: "week", fromMemberId: MARY, matchKeys: ["magic kingdom childcare"] })],
      payments,
      categorySpend: new Map(),
      rules: [],
      holderOf,
      nameOf,
    })
    expect(fees.items[0]).toMatchObject({ mismatch: false, actualPayers: ["Joint"], paidByOther: false })
  })
})

describe("payerConflicts (checked on every plan write)", () => {
  const rules = payerRules([SCHOOL_FEES_NOTE], members)
  test("school fees from Amit's account break the rule; from Mary's they don't", () => {
    const fromAmit = item({ id: 1, title: "School fees", fromAccountId: A.check })
    const fromMary = item({ id: 2, title: "School fees", fromAccountId: A.mary })
    expect(payerConflicts(fromAmit, rules, holderOf, nameOf)).toHaveLength(1)
    expect(payerConflicts(fromMary, rules, holderOf, nameOf)).toEqual([])
  })
})
