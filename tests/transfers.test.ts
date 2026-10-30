import { describe, expect, test } from "vitest"

import { planTransactions } from "@/lib/snapshot"
import { loanRepaymentIds, pairTransfers } from "@/supabase/functions/_shared/transfers"

import { ACCOUNTS, inputs } from "./fixtures/october-2026"

const t = (id: number, accountId: number, date: string, amount: number, description = "TFR") => ({
  id,
  accountId,
  date,
  amount,
  description,
})

describe("pairTransfers", () => {
  test("pairs equal and opposite amounts across accounts within three days, closest first", () => {
    const pairs = pairTransfers([
      t(1, 1, "2026-11-11", -943),
      t(2, 2, "2026-11-12", 943),
      t(3, 2, "2026-11-11", 943),
      t(4, 1, "2026-11-20", -50),
      t(5, 3, "2026-11-28", 50), // too far apart
      t(6, 1, "2026-11-21", 70),
      t(7, 1, "2026-11-21", -70), // same account: not a transfer
    ])
    expect(pairs).toEqual([
      { outId: 1, inId: 3, fromAccountId: 1, toAccountId: 2, amount: 943, date: "2026-11-11" },
    ])
  })

  test("a repayment into a loan account is a loan repayment, its cash side the bill", () => {
    const txs = [t(1, 2, "2026-10-15", -1817.54), t(2, 5, "2026-10-15", 1817.54)]
    const ids = loanRepaymentIds(txs, [
      { id: 2, type: "checking" },
      { id: 5, type: "loan" },
    ])
    expect([...ids]).toEqual([1])
  })

  test("an unpaired payment described as a loan repayment counts too", () => {
    const ids = loanRepaymentIds([t(1, 2, "2026-10-15", -900, "ASB HOME LOAN PMT")], [{ id: 2, type: "checking" }])
    expect([...ids]).toEqual([1])
  })
})

describe("planTransactions", () => {
  test("leaves out both sides of internal transfers but keeps loan repayments as bills", () => {
    const { txs, pairs, loanRepayments } = planTransactions(inputs().txs, Object.values(ACCOUNTS))
    expect(txs.some((x) => /VISA|PAYMENT RECEIVED|STREAMLINE|TFR TO JOINT/.test(x.description))).toBe(false)
    expect(txs.some((x) => x.description === "TFR FROM JOINT")).toBe(false)
    const loans = txs.filter((x) => x.description === "TFR TO HOME LOAN 01")
    expect(loans).toHaveLength(14)
    expect(loans.every((x) => x.categoryKind === "expense")).toBe(true)
    // 14 loan repayments, 7 Visa repayments and one Streamline top-up
    expect(pairs).toHaveLength(22)
    expect(loanRepayments.size).toBe(14)
  })
})

describe("planTransactions on a loan account", () => {
  const tx = (id: number, accountId: number, description: string, amount: number) => ({
    id,
    date: "2026-10-29",
    accountId,
    description,
    amount,
    categoryId: null,
    categoryKind: null,
    ruleId: null,
    ruleNote: null,
  })

  test("the loan's own lines aren't income or spending", () => {
    const accounts = [
      { id: 1, type: "checking" },
      { id: 2, type: "loan" },
    ]
    const { txs } = planTransactions(
      [tx(1, 2, "Principal payment", 222.22), tx(2, 2, "Interest", -620.85), tx(3, 1, "Salary", 5000)],
      accounts
    )
    expect(txs.map((t) => t.description)).toEqual(["Salary"])
  })
})
