import type { Metadata } from "next"
import Link from "next/link"
import { SparkleIcon } from "@phosphor-icons/react/ssr"

import { AutoCategorizeButton } from "./auto-categorize-button"
import { MerchantSearch } from "./merchant-search"
import { ReviewTable, UncategorizedTable } from "./review-table"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  LOW_CONFIDENCE,
  getCategories,
  getCategorizationStats,
  getUncategorizedMerchants,
  getRuleReview,
  getSettings,
  type ReviewFilter,
} from "@/lib/queries"

export const metadata: Metadata = { title: "Review categories" }

const FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "uncategorized", label: "Uncategorized" },
  { value: "low", label: `Needs review (<${LOW_CONFIDENCE}%)` },
  { value: "ai", label: "AI" },
  { value: "rules", label: "Rules & learned" },
]

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const raw = Array.isArray(sp.filter) ? sp.filter[0] : sp.filter
  const filter = FILTERS.some((f) => f.value === raw) ? (raw as ReviewFilter) : "all"
  const view = sp.view === "category" ? "category" : "list"
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() || undefined
  const href = (next: { filter?: ReviewFilter; view?: string }) => {
    const p = new URLSearchParams()
    const f = next.filter ?? filter
    const v = next.view ?? view
    if (f !== "all") p.set("filter", f)
    if (v !== "list") p.set("view", v)
    if (q) p.set("q", q)
    return p.size ? `/review?${p}` : "/review"
  }

  const showUncategorized = filter === "all" || filter === "uncategorized"
  const [rows, uncategorized, stats, categories, fmt] = await Promise.all([
    getRuleReview(filter, q),
    showUncategorized ? getUncategorizedMerchants(q) : [],
    getCategorizationStats(),
    getCategories(),
    getSettings(),
  ])
  const options = categories.map(({ id, name, kind }) => ({ id, name, kind }))

  const tiles = [
    { label: "Uncategorized", value: stats.uncategorized },
    { label: "By AI", value: stats.ai },
    { label: "By rules", value: stats.rule },
    { label: "Set by you", value: stats.manual },
    { label: "Need review", value: stats.low },
  ]

  return (
    <>
      <PageHeader
        title="Review categories"
        description="Rules and learned merchants run first for free. Only merchants nothing matches are sent to Claude, and each answer becomes a rule."
      >
        <AutoCategorizeButton uncategorized={stats.uncategorized} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} size="sm">
            <CardHeader>
              <CardDescription>{t.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{t.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MerchantSearch />
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={f.value === filter ? "secondary" : "ghost"}
            nativeButton={false}
            render={<Link href={href({ filter: f.value })} />}
          >
            {f.label}
          </Button>
        ))}
        <div className="flex w-full gap-1 sm:ml-auto sm:w-auto">
          {[
            { value: "list", label: "By confidence" },
            { value: "category", label: "By category" },
          ].map((v) => (
            <Button
              key={v.value}
              size="sm"
              variant={v.value === view ? "outline" : "ghost"}
              nativeButton={false}
              render={<Link href={href({ view: v.value })} />}
            >
              {v.label}
            </Button>
          ))}
        </div>
      </div>

      {uncategorized.length > 0 && (
        <Card className="pb-0">
          <CardHeader>
            <CardTitle>Uncategorized</CardTitle>
            <CardDescription>
              Nothing matched these and Claude wasn&apos;t sure, or you cleared them. Pick a
              category and it&apos;s remembered for future imports.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <UncategorizedTable rows={uncategorized} categories={options} fmt={fmt} />
          </CardContent>
        </Card>
      )}

      {filter === "uncategorized" ? null : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparkleIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>
              {filter === "all" && !q
                ? "Auto-categorized merchants show up here with their confidence."
                : q
                  ? `No merchants match “${q}”.`
                  : "No merchants match this filter."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        view === "category" ? (
          categories
            .filter((c) => rows.some((r) => r.categoryId === c.id))
            .map((c) => {
              const group = rows.filter((r) => r.categoryId === c.id)
              const txs = group.reduce((n, r) => n + r.txCount, 0)
              return (
                <Card key={c.id} id={`cat-${c.id}`} className="scroll-mt-16 pb-0">
                  <CardHeader>
                    <CardTitle>{c.name}</CardTitle>
                    <CardDescription>
                      {group.length} {group.length === 1 ? "merchant" : "merchants"} · {txs}{" "}
                      transactions
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="px-0">
                    <ReviewTable rows={group} categories={options} fmt={fmt} />
                  </CardContent>
                </Card>
              )
            })
        ) : (
          <Card className="py-0">
            <CardContent className="px-0">
              <ReviewTable rows={rows} categories={options} fmt={fmt} />
            </CardContent>
          </Card>
        )
      )}
    </>
  )
}
