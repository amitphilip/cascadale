"use client"

import { SparkleIcon } from "@phosphor-icons/react"

import { runAutoCategorize } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

export function AutoCategorizeButton({ uncategorized }: { uncategorized: number }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      disabled={pending || uncategorized === 0}
      onClick={() =>
        execute(() => runAutoCategorize(), {
          success: (r) => {
            const parts = []
            if (r.byRules) parts.push(`${r.byRules} matched by rules`)
            if (r.merchantsAsked) {
              parts.push(`${r.byAi} categorized by AI from ${r.merchantsAsked} merchants`)
            }
            if (r.remaining) parts.push(`${r.remaining} still uncategorized`)
            return parts.length ? parts.join(", ") : "Nothing to categorize"
          },
        })
      }
    >
      <SparkleIcon data-icon="inline-start" />
      {pending ? "Categorizing…" : `Auto-categorize ${uncategorized}`}
    </Button>
  )
}
