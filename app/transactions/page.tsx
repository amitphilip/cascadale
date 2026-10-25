import type { Metadata } from "next"
import Link from "next/link"
import { ListBulletsIcon, NoteIcon, PlusIcon } from "@phosphor-icons/react/ssr"

import { TransactionFilters } from "./filters"
import { InlineCategory, TransactionRowActions } from "./transaction-row-actions"
import { PageHeader } from "@/components/page-header"
import { ConfidenceBadge } from "@/components/confidence-badge"
import { TransactionDialog } from "@/components/transaction-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDate, formatMoney, formatMonth } from "@/lib/format"
import {
  getAccountsWithBalances,
  getCategories,
  getSettings,
  getTransactionMonths,
  getTransactions,
} from "@/lib/queries"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Transactions" }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v
}

export default async function TransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  const category = one(sp.category)
  const filters = {
    account: Number(one(sp.account)) || undefined,
    category: category === "none" ? ("none" as const) : Number(category) || undefined,
    rule: Number(one(sp.rule)) || undefined,
    month: one(sp.month),
    q: one(sp.q)?.trim() || undefined,
    page: Number(one(sp.page)) || 1,
  }

  const [data, accounts, categories, months, fmt] = await Promise.all([
    getTransactions(filters),
    getAccountsWithBalances(),
    getCategories(),
    getTransactionMonths(),
    getSettings(),
  ])
  const accountOptions = accounts
    .filter((a) => !a.archived)
    .map((a) => ({ id: a.id, name: a.name }))
  const allAccounts = accounts.map((a) => ({ id: a.id, name: a.name }))
  const categoryOptions = categories.map(({ id, name, kind }) => ({ id, name, kind }))
  const monthLabels = Object.fromEntries(months.map((m) => [m, formatMonth(m, fmt.locale)]))

  const pageHref = (page: number) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      const val = one(v)
      if (val && k !== "page") p.set(k, val)
    }
    if (page > 1) p.set("page", String(page))
    return `/transactions?${p}`
  }

  const addButton = (
    <Button disabled={accountOptions.length === 0}>
      <PlusIcon data-icon="inline-start" />
      Add transaction
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Transactions"
        description="Categorize inline, or open a row's menu to edit details and add notes."
      >
        <TransactionDialog
          accounts={accountOptions}
          categories={categoryOptions}
          trigger={addButton}
        />
      </PageHeader>

      {filters.rule && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            Showing transactions categorized by one rule.
          </span>
          <Button variant="link" size="sm" className="h-auto p-0" nativeButton={false} render={<Link href="/review" />}>
            Back to review
          </Button>
          <Button variant="link" size="sm" className="h-auto p-0 sm:ml-auto" nativeButton={false} render={<Link href="/transactions" />}>
            Clear
          </Button>
        </div>
      )}

      <TransactionFilters
        accounts={allAccounts}
        categories={categoryOptions}
        months={months}
        monthLabels={monthLabels}
      />

      {data.total === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListBulletsIcon />
            </EmptyMedia>
            <EmptyTitle>No transactions found</EmptyTitle>
            <EmptyDescription>
              {months.length === 0
                ? "Import a statement to get started, or add a transaction by hand."
                : "Nothing matches these filters."}
            </EmptyDescription>
          </EmptyHeader>
          {months.length === 0 && (
            <EmptyContent>
              <Button nativeButton={false} render={<Link href="/import" />}>Import a statement</Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>
              <span className="font-medium text-foreground tabular-nums">{data.total}</span>{" "}
              transactions
            </span>
            <span>
              In{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatMoney(data.inflow, fmt)}
              </span>
            </span>
            <span>
              Out{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatMoney(Math.abs(data.outflow), fmt)}
              </span>
            </span>
            <span>
              Net{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatMoney(data.inflow + data.outflow, fmt, { signed: true })}
              </span>
            </span>
          </div>
          <Card className="py-0 md:hidden">
            <CardContent className="divide-y px-0">
              {data.rows.map((t) => (
                <div key={t.id} className="grid gap-2 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium break-words">{t.description}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDate(t.date, fmt.locale)} · {t.accountName}
                        {t.source === "manual" ? " · Manual" : ""}
                      </div>
                      {t.notes && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.notes}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <span
                        className={cn(
                          "font-medium tabular-nums",
                          t.amount > 0 && "text-primary"
                        )}
                      >
                        {formatMoney(t.amount, fmt, { signed: true })}
                      </span>
                      <TransactionRowActions
                        transaction={t}
                        accounts={allAccounts}
                        categories={categoryOptions}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <InlineCategory
                      key={`${t.id}-${t.categoryId}`}
                      txId={t.id}
                      categoryId={t.categoryId}
                      categories={categoryOptions}
                      className={
                        t.categoryId === null
                          ? "w-full border-dashed text-muted-foreground"
                          : "w-full"
                      }
                    />
                    {t.categoryId !== null && t.categorySource !== "manual" && (
                      <ConfidenceBadge
                        source={t.categorySource}
                        confidence={t.categoryConfidence}
                      />
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="hidden py-0 md:block">
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28 pl-4">Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-12 pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="pl-4 whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatDate(t.date, fmt.locale)}
                      </TableCell>
                      <TableCell className="max-w-md">
                        <div className="flex items-center gap-2">
                          <span className="truncate" title={t.description}>
                            {t.description}
                          </span>
                          {t.notes && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <NoteIcon aria-label="Has a note" className="size-4 shrink-0 text-muted-foreground" />
                                }
                              />
                              <TooltipContent className="max-w-xs">{t.notes}</TooltipContent>
                            </Tooltip>
                          )}
                          {t.source === "manual" && (
                            <Badge variant="outline" className="shrink-0">
                              Manual
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {t.accountName}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <InlineCategory
                            key={`${t.id}-${t.categoryId}`}
                            txId={t.id}
                            categoryId={t.categoryId}
                            categories={categoryOptions}
                          />
                          {t.categoryId !== null && t.categorySource !== "manual" && (
                            <ConfidenceBadge
                              source={t.categorySource}
                              confidence={t.categoryConfidence}
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium whitespace-nowrap tabular-nums",
                          t.amount > 0 && "text-primary"
                        )}
                      >
                        {formatMoney(t.amount, fmt, { signed: true })}
                      </TableCell>
                      <TableCell className="pr-4">
                        <TransactionRowActions
                          transaction={t}
                          accounts={allAccounts}
                          categories={categoryOptions}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {data.pageCount > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm sm:justify-end">
              <span className="text-muted-foreground">
                Page {data.page} of {data.pageCount}
              </span>
              {data.page <= 1 ? (
                <Button variant="outline" size="sm" disabled>
                  Previous
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={pageHref(data.page - 1)} />}
                >
                  Previous
                </Button>
              )}
              {data.page >= data.pageCount ? (
                <Button variant="outline" size="sm" disabled>
                  Next
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={pageHref(data.page + 1)} />}
                >
                  Next
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}
