import type { RecurringTx } from "@/lib/recurring"
import {
  loanRepaymentIds,
  pairTransfers,
  type TransferTx,
} from "@/supabase/functions/_shared/transfers"

/**
 * The transactions that count as real income and spending, from the raw rows: transfers
 * between your own accounts come out. Pure, so the server and the tests agree.
 */

/** A transaction in the averaging window, transfers included. */
export type WindowTx = Omit<RecurringTx, "categoryKind"> & {
  id: number
  categoryKind: RecurringTx["categoryKind"] | "transfer"
}

/** Pseudo category for loan repayments, which are transfers into a loan account. */
export const LOAN_CATEGORY_ID = -1
export const LOAN_CATEGORY = "Loan repayments"

/**
 * The transactions that count: transfers between your own accounts are left out
 * (both sides, matched by amount and date, whether or not they're categorized yet), except
 * the cash side of a loan repayment, which is a bill. Nothing on a loan account itself
 * counts: its principal and interest lines are that same repayment seen from the loan.
 */
export function countedTransactions(txs: WindowTx[], accounts: { id: number; type: string }[]) {
  // only uncategorized money and transfers can be one side of a transfer; a categorized
  // salary that happens to match a payment elsewhere is still a salary
  const candidates: TransferTx[] = txs.filter(
    (t) => t.categoryKind === null || t.categoryKind === "transfer"
  )
  const pairs = pairTransfers(candidates)
  const loans = loanRepaymentIds(candidates, accounts, pairs)
  const paired = new Set(pairs.flatMap((p) => [p.outId, p.inId]))
  const loanAccounts = new Set(accounts.filter((a) => a.type === "loan").map((a) => a.id))
  const out: RecurringTx[] = []
  for (const t of txs) {
    if (loanAccounts.has(t.accountId)) continue
    if (loans.has(t.id)) {
      out.push({
        date: t.date,
        accountId: t.accountId,
        description: t.description,
        amount: t.amount,
        categoryId: LOAN_CATEGORY_ID,
        categoryKind: "expense",
        ruleId: null,
        ruleNote: t.ruleNote,
      })
    } else if (t.categoryKind !== "transfer" && !paired.has(t.id)) {
      out.push({
        date: t.date,
        accountId: t.accountId,
        description: t.description,
        amount: t.amount,
        categoryId: t.categoryId,
        categoryKind: t.categoryKind,
        ruleId: t.ruleId,
        ruleNote: t.ruleNote,
      })
    }
  }
  return { txs: out, pairs, loanRepayments: loans }
}
