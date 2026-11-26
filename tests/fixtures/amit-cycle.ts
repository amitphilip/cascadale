import { myAllocation, type MoveTx, type PaySource } from "@/lib/my-allocation"
import { cyclePosition } from "@/lib/planning/cycle"
import type { RecurringPayment } from "@/lib/planning/recurring-payments"
import type { Goal, WhatIfRequest } from "@/lib/planning/what-if"

// Amit's pay cycle on 26 November: paid $5,122.36 into Check on the 25th, the next pay on
// 9 December. The plan moves $2,555 to Joint, $130 to Cabin, $275 to AOC and $105 to
// Everyday Saving each pay; Joint has gone and the rest haven't.
export const TODAY = "2026-11-26"
export const AMIT = "amit-id"
export const CHECK = 1
export const JOINT = 34
export const CARD = 35
export const SAVING = 102
export const AOC = 100
export const CABIN = 108
export const EMERGENCY = 113
const SALARY = 1
const TRANSFER = 20

export const allocations = [
  { id: 110, title: "Mortgage and school fees", purpose: "bills" as const, amount: 2555, every: "fortnight" as const, categoryId: null, accountId: JOINT, fromAccountId: CHECK },
  { id: 111, title: "Cabin King", purpose: "bills" as const, amount: 130, every: "fortnight" as const, categoryId: null, accountId: CABIN, fromAccountId: CHECK },
  { id: 123, title: "AOC obstetrician fund", purpose: "one_off" as const, amount: 275, every: "fortnight" as const, categoryId: null, accountId: AOC, fromAccountId: CHECK },
  { id: 130, title: "Everyday Saving", purpose: "savings" as const, amount: 105, every: "fortnight" as const, categoryId: null, accountId: SAVING, fromAccountId: CHECK },
]

let next = 1
const tx = (accountId: number, date: string, amount: number, categoryId: number | null, description = "TX"): MoveTx => ({
  id: next++,
  accountId,
  date,
  amount,
  categoryId,
  description,
})
const txs = [
  tx(CHECK, "2026-11-25", 5122.36, SALARY, "Wood Partners"),
  tx(CHECK, "2026-11-25", -2555, TRANSFER, "MB TRANSFER TO JOINT"),
  tx(JOINT, "2026-11-25", 2555, TRANSFER, "MB TRANSFER EX CHECK"),
]

const wood: PaySource = {
  name: "Wood Partners",
  accountId: CHECK,
  every: "fortnight",
  amount: 5122.36,
  monthly: 11097.91,
  lastDate: "2026-11-25",
  nextDate: "2026-12-09",
}

export const cycle = { start: "2026-11-25", end: "2026-12-09", days: 14, pay: { name: "Wood Partners", accountId: CHECK, every: "fortnight" as const, amount: 5122.36 } }

export const allocation = myAllocation({
  today: TODAY,
  cycle,
  mine: [CHECK, SAVING],
  allocations,
  txs,
  categories: [
    { id: SALARY, kind: "income" },
    { id: TRANSFER, kind: "transfer" },
  ],
  sources: [wood],
  bills: [],
  payEvery: new Map([[CHECK, "fortnight"]]),
  accountName: new Map([
    [CHECK, "Check Account - Amit"],
    [JOINT, "Check Account - Joint"],
    [CABIN, "Cabin"],
    [AOC, "AOC"],
    [SAVING, "Everyday Saving"],
  ]),
})

export const payment = (p: Partial<RecurringPayment> & { key: string; name: string; typicalAmount: number; nextExpected: string; cadence: RecurringPayment["cadence"] }): RecurringPayment => ({
  matchKey: p.key,
  example: p.name,
  kind: "payment",
  fromAccountId: CHECK,
  fromAccount: "Check Account - Amit",
  ownerId: AMIT,
  owner: "Amit",
  toAccountId: null,
  toAccount: null,
  categoryId: null,
  lastAmount: p.typicalAmount,
  minAmount: p.typicalAmount,
  maxAmount: p.typicalAmount,
  amountVaries: false,
  monthly: p.typicalAmount,
  count: 6,
  firstDate: "2026-06-01",
  lastDate: "2026-11-01",
  overdue: false,
  confidence: "high",
  ...p,
})

// the bills that come out of Check before the next pay
export const payments = [
  payment({ key: `${CHECK}|aia`, name: "AIA", typicalAmount: 140.48, nextExpected: "2026-12-08", cadence: "fortnightly" }),
  payment({ key: `${CHECK}|mercury`, name: "Mercury", typicalAmount: 386.68, nextExpected: "2026-12-02", cadence: "monthly" }),
  payment({ key: `${CHECK}|spark`, name: "Spark", typicalAmount: 94.99, nextExpected: "2026-12-08", cadence: "monthly" }),
]

export const position = (balance: number) =>
  cyclePosition({
    today: TODAY,
    allocation,
    planItems: allocations,
    lines: [],
    mine: [CHECK, SAVING],
    balances: new Map([
      [CHECK, balance],
      [SAVING, 495],
      [EMERGENCY, 547.58],
    ]),
    accountName: new Map([
      [CHECK, "Check Account - Amit"],
      [SAVING, "Everyday Saving"],
    ]),
    payments,
    covered: new Set(),
    paysDue: [],
  })

export const goals: Goal[] = [
  {
    ref: "plan_item:130",
    kind: "plan_item",
    name: "Everyday Saving",
    purpose: "savings",
    planItemId: 130,
    oneOffId: null,
    accountId: SAVING,
    account: "Everyday Saving",
    fromAccountId: CHECK,
    target: 2000,
    saved: 495,
    ratePerWeek: 52.5,
    finishDate: null,
    leftThisPay: 105,
    plannedThisPay: 105,
    shared: false,
  },
  {
    ref: "plan_item:123",
    kind: "plan_item",
    name: "AOC obstetrician fund",
    purpose: "one_off",
    planItemId: 123,
    oneOffId: 1,
    accountId: AOC,
    account: "AOC",
    fromAccountId: CHECK,
    target: 5360,
    saved: 3301.73,
    ratePerWeek: 137.5,
    finishDate: "2027-03-15",
    leftThisPay: 275,
    plannedThisPay: 275,
    shared: false,
  },
]

export const ipad: WhatIfRequest = { memberId: AMIT, amount: 1200, date: TODAY, accountId: null, description: "iPad", spreadOver: null }

