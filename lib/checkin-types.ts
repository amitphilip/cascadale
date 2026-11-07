import { z } from "zod"

/**
 * A check-in: what changed since you last logged statements, measured against what the
 * plan expects, and the model's advice on staying on track. Shared by the server (which
 * computes and stores it) and the overview (which renders it).
 */

export type CheckInStats = {
  /** first and last date of the transactions looked at */
  from: string
  to: string
  days: number
  /** "new": logged since the last check-in; "recent": nothing new, so the last 30 days */
  basis: "new" | "recent"
  newCount: number
  currency: string
  income: number
  spending: number
  net: number
  /** what the plan's projections expect over the same number of days */
  expectedIncome: number
  expectedSpending: number
  incomeItems: {
    date: string
    description: string
    amount: number
    account: string
  }[]
  bigExpenses: {
    date: string
    description: string
    amount: number
    category: string
  }[]
  /** spending per category against its projection for the same number of days */
  categories: { name: string; spent: number; expected: number }[]
  /** change: how much the balance moved between from and to, transfers included */
  accounts: { name: string; type: string; balance: number; change: number }[]
  cashNow: number
  /** recurring bills due in the next 30 days */
  upcomingBills: {
    date: string
    name: string
    amount: number
    account: string
  }[]
  /** your one-off expenses in the next 90 days */
  upcomingOneOffs: {
    date: string
    name: string
    amount: number
    account: string | null
  }[]
  /** lowest projected combined balance (all accounts but loans and revolving credit) over the next 60 days */
  low: { date: string; balance: number } | null
  plan: {
    summary: string
    setAsides: { pot: string; amount: number; when: string; to: string }[]
  } | null
  /** the plan's end goal as a net position (cash less cards; loans and revolving credit left out); missing on old check-ins */
  goal?: {
    endDate: string
    target: number
    targetSplit: { cash: number; owed: number }
    forecast: number
    forecastSplit: { cash: number; owed: number }
    gap: number
    /** the last day with data: where the plan expected you to be, and where you were */
    latest: {
      date: string
      planned: number
      actual: number
      cash: number
      owed: number
      /** actual against the plan, revolving credit included */
      offPlan?: number
    } | null
    /** what's owed on revolving credit (flexi), left out of the net figures; missing on old check-ins */
    debt?: {
      accounts: string[]
      startedAt: number
      now: number
      target: number
      forecast: number
    } | null
  } | null
}

export const CHECK_IN_STATUSES = ["on_track", "watch", "off_track"] as const
export type CheckInStatus = (typeof CHECK_IN_STATUSES)[number]

export const CHECK_IN_STATUS_LABELS: Record<CheckInStatus, string> = {
  on_track: "On track",
  watch: "Keep an eye on it",
  off_track: "Off track",
}

export const CheckInResultSchema = z.object({
  status: z
    .enum(CHECK_IN_STATUSES)
    .describe("Overall: on_track, watch, or off_track"),
  headline: z.string().describe("At most 12 words: the one thing to know"),
  paragraph: z
    .string()
    .describe(
      "Three to five plain sentences: what came in, what went out and how that compares with the plan, and what is coming up. Lead with numbers."
    ),
  actions: z
    .array(
      z.object({
        title: z.string().describe("At most 6 words, imperative"),
        detail: z
          .string()
          .describe("One sentence, at most 25 words, with the key number"),
        amount: z.number().nullable().describe("Money involved, or null"),
        by: z.string().nullable().describe("YYYY-MM-DD to do it by, or null"),
      })
    )
    .describe(
      "Two to five things to do now to stay on the plan, most important first"
    ),
  plan_changes: z
    .array(
      z.object({
        date: z.string().describe("YYYY-MM-DD when the change applies"),
        change: z
          .string()
          .describe(
            "At most 20 words: how to adjust the plan around that date"
          ),
        amount: z
          .number()
          .nullable()
          .describe("Amount to move, reduce or add, or null"),
      })
    )
    .describe(
      "Dated, temporary adjustments to the plan for upcoming expenses or shortfalls; empty if none are needed. At most four."
    ),
})
export type CheckInResult = z.infer<typeof CheckInResultSchema>
