import { describe, expect, test } from "vitest"

import { counterpartyKey, detectRecurring, findSeriesBreaks, type RecurringTx } from "@/lib/recurring"

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

const tx = (date: string, description: string, amount: number, ruleId: number | null = null): RecurringTx => ({
  date,
  accountId: 1,
  description,
  amount,
  categoryId: 1,
  categoryKind: amount > 0 ? "income" : "expense",
  ruleId,
  ruleNote: null,
})

describe("counterpartyKey", () => {
  test("drops channel prefixes and reference tokens", () => {
    expect(counterpartyKey("D/C FROM Wood Partners Consu")).toBe("wood partners consu")
    expect(counterpartyKey("Wood Partners Consu WoodiPayroll41494-0579")).toBe("wood partners consu")
    expect(counterpartyKey("A/P TO Mercury Energy 1234")).toBe("mercury energy")
    expect(counterpartyKey("TFR TO HOME LOAN 01")).toBe("home loan")
  })
})

describe("detectRecurring", () => {
  test("one fortnightly series across two descriptions and two rules", () => {
    const txs = Array.from({ length: 10 }, (_, k) => {
      const date = addDays("2026-06-03", 14 * k)
      return k < 5
        ? tx(date, "D/C FROM Wood Partners Consu", 3100, 11)
        : tx(date, "Wood Partners Consu WoodiPayroll41494-0579", 3100 + (k % 2) * 20, 12)
    })
    const series = detectRecurring(txs, "2026-10-20")
    expect(series).toHaveLength(1)
    expect(series[0].cadence).toBe("fortnightly")
    expect(series[0].aliases.sort()).toEqual(["1:in:r11", "1:in:r12"])
    expect(series[0].occurrences).toHaveLength(10)
  })

  test("doesn't merge a different counterparty or a very different amount", () => {
    const txs = Array.from({ length: 6 }, (_, k) => [
      tx(addDays("2026-06-01", 30 * k), "MERCURY ENERGY", -200),
      tx(addDays("2026-06-03", 30 * k), "ONE NZ BROADBAND", -95),
      tx(addDays("2026-06-05", 30 * k), "MERCURY ENERGY GAS", -900),
    ]).flat()
    expect(detectRecurring(txs, "2026-11-10")).toHaveLength(3)
  })
})

describe("findSeriesBreaks", () => {
  test("flags a new payer at the same amount and cadence after the old one stopped", () => {
    const old = Array.from({ length: 6 }, (_, k) => tx(addDays("2026-04-01", 14 * k), "OLD EMPLOYER LTD", 2500))
    const fresh = Array.from({ length: 4 }, (_, k) => tx(addDays("2026-06-24", 14 * k), "NEW CO PAYROLL", 2550))
    const txs = [...old, ...fresh]
    const series = detectRecurring(txs, "2026-08-14")
    const breaks = findSeriesBreaks(txs, series, "2026-08-14")
    expect(breaks).toHaveLength(1)
    expect(breaks[0].ended.example).toBe("OLD EMPLOYER LTD")
    expect(breaks[0].candidate.example).toBe("NEW CO PAYROLL")
  })
})
