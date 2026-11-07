import { describe, expect, it } from "vitest"

import { merchantKey } from "@/supabase/functions/_shared/rules"
import {
  MAX_MERCHANT_TODOS,
  todoChanges,
  uncategorizedTodos,
} from "@/supabase/functions/_shared/uncategorized-todos"

const money = (n: number) => n.toFixed(2)

describe("uncategorizedTodos", () => {
  it("raises one action — why — how to-do per merchant", () => {
    const todos = uncategorizedTodos(
      [
        { description: "POS 1234 BLUE BOTTLE #22", amount: -5 },
        { description: "BLUE BOTTLE 99", amount: -7.5 },
      ],
      merchantKey,
      money
    )
    expect([...todos.entries()]).toEqual([
      [
        "uncategorized:blue bottle",
        'Categorise POS 1234 BLUE BOTTLE #22 — 2 synced txns (-12.50) have no category, so budgets miss them — ask which category, then categorize_merchant "blue bottle".',
      ],
    ])
  })

  it("rolls merchants past the limit into one to-do", () => {
    const rows = Array.from({ length: MAX_MERCHANT_TODOS + 3 }, (_, i) => ({
      description: `Shop ${String.fromCharCode(97 + i)}x`,
      amount: -1,
    }))
    const todos = uncategorizedTodos(rows, merchantKey, money)
    expect(todos.size).toBe(MAX_MERCHANT_TODOS + 1)
    expect(todos.get("uncategorized:*")).toMatch(/^Categorise 3 more merchants — 3 synced txns/)
  })
})

describe("todoChanges", () => {
  const wanted = new Map([
    ["uncategorized:a", "A v2"],
    ["uncategorized:b", "B"],
    ["uncategorized:c", "C"],
  ])

  it("adds, updates and resolves against what's open", () => {
    const changes = todoChanges(
      wanted,
      [
        { id: 1, ref: "uncategorized:a", content: "A v1" },
        { id: 2, ref: "uncategorized:gone", content: "G" },
      ],
      []
    )
    expect(changes).toEqual({
      insert: [
        { ref: "uncategorized:b", content: "B" },
        { ref: "uncategorized:c", content: "C" },
      ],
      update: [{ id: 1, content: "A v2" }],
      resolve: [2],
    })
  })

  it("doesn't raise a dismissed to-do again until its numbers change", () => {
    const changes = todoChanges(
      wanted,
      [],
      [
        { id: 3, ref: "uncategorized:b", content: "B" },
        { id: 4, ref: "uncategorized:c", content: "C old" },
      ]
    )
    expect(changes.insert.map((t) => t.ref)).toEqual(["uncategorized:a", "uncategorized:c"])
  })
})
