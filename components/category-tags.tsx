"use client"

import Link from "next/link"
import { SparkleIcon, XIcon } from "@phosphor-icons/react"

import { deleteRule } from "@/app/actions"
import { Badge } from "@/components/ui/badge"
import { useServerAction } from "@/hooks/use-server-action"

type Tag = {
  id: number
  pattern: string
  kind: "contains" | "merchant"
  source: "manual" | "ai" | "learned"
  txCount: number
}

const SHOWN = 6

/** The merchants and rules filed under a category, busiest first. */
export function CategoryTags({ tags, categoryId }: { tags: Tag[]; categoryId: number }) {
  const { execute } = useServerAction()
  if (tags.length === 0) return null
  const rest = tags.length - SHOWN
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tags.slice(0, SHOWN).map((t) => (
        <Badge
          key={t.id}
          variant="outline"
          className="font-normal text-muted-foreground capitalize"
          title={`${t.kind === "contains" ? "Your rule" : t.source === "ai" ? "From AI" : "Learned"} · ${t.txCount} transactions`}
        >
          <Link href={`/transactions?rule=${t.id}`} className="flex items-center gap-1">
            {t.source === "ai" && <SparkleIcon data-icon="inline-start" />}
            {t.kind === "contains" ? `“${t.pattern}”` : t.pattern}
            <span className="tabular-nums opacity-70">{t.txCount}</span>
          </Link>
          <button
            type="button"
            aria-label={`Delete rule ${t.pattern}`}
            className="opacity-50 hover:opacity-100"
            onClick={() => execute(() => deleteRule(t.id), { success: "Rule deleted" })}
          >
            <XIcon className="size-2.5!" />
          </button>
        </Badge>
      ))}
      {rest > 0 && (
        <Badge
          variant="ghost"
          className="font-normal text-muted-foreground"
          render={<Link href={`/review?view=category#cat-${categoryId}`} />}
        >
          +{rest} more
        </Badge>
      )}
    </div>
  )
}
