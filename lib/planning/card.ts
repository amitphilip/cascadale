// Credit cards: what's owed and when it's usually paid. Akahu's feed gives a card's balance
// but not its statement balance, due date or minimum payment, so those come from the
// household's own pattern of paying it: the recurring transfers into the card account.
// Pure.

import type { RecurringPayment } from "@/lib/planning/recurring-payments"

const round2 = (n: number) => Math.round(n * 100) / 100 + 0

export type CardPosition = {
  accountId: number
  name: string
  owner: string
  /** owed, as a positive amount */
  owed: number
  /** what the bank feed says about the statement; null: Akahu doesn't provide it */
  statement: { balance: number; dueDate: string; minimumPayment: number | null } | null
  source: "pattern"
  /** how it's usually paid off, from the recurring payments into it */
  usualPayments: {
    from: string
    owner: string
    cadence: string
    typicalAmount: number
    lastAmount: number
    lastDate: string
    nextExpected: string
    confidence: string
  }[]
  /** the next payment the pattern expects: the stand-in for the due date */
  nextPaymentExpected: string | null
  /** spending on the card per month, and paid into it per month, over the same months */
  monthlySpend: number
  monthlyPaid: number
  /** paid in step with what goes on it (within 10%), so it's likely cleared each statement */
  paysInFull: boolean | null
  note: string
}

export function cardPositions(input: {
  cards: { id: number; name: string; balance: number; owner: string }[]
  payments: RecurringPayment[]
  /** money out of each card account (spending), per month on average */
  spendByCard: Map<number, number>
  /** money into each card account, per month on average */
  paidByCard: Map<number, number>
}): CardPosition[] {
  return input.cards.map((c) => {
    const usual = input.payments
      .filter((p) => p.toAccountId === c.id)
      .sort((a, b) => a.nextExpected.localeCompare(b.nextExpected))
    const spend = round2(input.spendByCard.get(c.id) ?? 0)
    const paid = round2(input.paidByCard.get(c.id) ?? 0)
    const paysInFull = spend <= 0 ? null : paid >= spend * 0.9
    return {
      accountId: c.id,
      name: c.name,
      owner: c.owner,
      owed: round2(Math.max(0, -c.balance)),
      statement: null,
      source: "pattern" as const,
      usualPayments: usual.map((p) => ({
        from: p.fromAccount,
        owner: p.owner,
        cadence: p.cadence,
        typicalAmount: p.typicalAmount,
        lastAmount: p.lastAmount,
        lastDate: p.lastDate,
        nextExpected: p.nextExpected,
        confidence: p.confidence,
      })),
      nextPaymentExpected: usual[0]?.nextExpected ?? null,
      monthlySpend: spend,
      monthlyPaid: paid,
      paysInFull,
      note:
        usual.length === 0
          ? "Akahu doesn't give the statement balance or due date, and no regular payment into this card was found: ask when it's due."
          : "Akahu doesn't give the statement balance or due date; the next payment date is when it's usually paid.",
    }
  })
}
