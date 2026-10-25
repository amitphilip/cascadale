import type { Metadata } from "next"
import { PlusIcon } from "@phosphor-icons/react/ssr"

import { CategoryActions } from "./category-actions"
import { RulesPanel } from "./rules-panel"
import { CategoryDialog } from "@/components/category-dialog"
import { CategoryTags } from "@/components/category-tags"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CATEGORY_KINDS } from "@/lib/db/schema"
import { CATEGORY_KIND_LABELS, formatMoney } from "@/lib/format"
import {
  getCategoriesWithUsage,
  getRules,
  getRuleTags,
  getSettings,
  getUncategorizedCount,
} from "@/lib/queries"

export const metadata: Metadata = { title: "Categories & rules" }

export default async function CategoriesPage() {
  const [categories, rules, tags, uncategorized, fmt] = await Promise.all([
    getCategoriesWithUsage(),
    getRules(),
    getRuleTags(),
    getUncategorizedCount(),
    getSettings(),
  ])
  const options = categories.map(({ id, name, kind }) => ({ id, name, kind }))
  const tagsByCategory = Map.groupBy(tags, (t) => t.categoryId)

  return (
    <>
      <PageHeader
        title="Categories & rules"
        description="Your categories drive every report. Rules categorize imports automatically."
      >
        <CategoryDialog
          trigger={
            <Button>
              <PlusIcon data-icon="inline-start" />
              Add category
            </Button>
          }
        />
      </PageHeader>

      <RulesPanel rules={rules} categories={options} uncategorized={uncategorized} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {CATEGORY_KINDS.map((kind) => (
          <Card key={kind} className={kind === "expense" ? "pb-0 lg:row-span-2" : "pb-0"}>
            <CardHeader>
              <CardTitle>{CATEGORY_KIND_LABELS[kind]}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Name</TableHead>
                    {kind === "expense" && <TableHead className="text-right">Budget</TableHead>}
                    <TableHead className="text-right">Uses</TableHead>
                    <TableHead className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categories
                    .filter((c) => c.kind === kind)
                    .map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="pl-4 whitespace-normal">
                          <div className="font-medium">{c.name}</div>
                          <CategoryTags tags={tagsByCategory.get(c.id) ?? []} categoryId={c.id} />
                        </TableCell>
                        {kind === "expense" && (
                          <TableCell className="text-right text-muted-foreground tabular-nums">
                            {c.monthlyBudget ? formatMoney(c.monthlyBudget, fmt) : "—"}
                          </TableCell>
                        )}
                        <TableCell className="text-right tabular-nums">{c.txCount}</TableCell>
                        <TableCell className="pr-4">
                          <CategoryActions category={c} txCount={c.txCount} />
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}
