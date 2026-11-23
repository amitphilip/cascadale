"use client"

import { useState } from "react"
import Link from "next/link"
import { CheckIcon, NoteIcon, NotePencilIcon, SparkleIcon } from "@phosphor-icons/react"

import { categorizeMerchant, confirmRule, recategorizeRule, setRuleNote } from "@/app/actions"
import { CategoryPicker, type CategoryOption } from "@/components/category-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useServerAction } from "@/hooks/use-server-action"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import { cn } from "@/lib/utils"

type ReviewRow = {
  id: number
  pattern: string
  kind: "contains" | "merchant"
  source: "manual" | "ai" | "learned"
  categoryId: number
  txCount: number
  autoCount: number
  total: number
  confidence: number
  example: string
  note: string | null
  reason: string | null
}

const SOURCE_LABEL = { ai: "AI", learned: "Learned", manual: "Your rule" } as const

export function ReviewTable({
  rows,
  categories,
  fmt,
}: {
  rows: ReviewRow[]
  categories: CategoryOption[]
  fmt: MoneyFormat
}) {
  return (
    <>
      <div className="grid divide-y md:hidden">
        {rows.map((r) => (
          <ReviewCard
            key={`${r.id}-${r.categoryId}-${r.confidence}`}
            row={r}
            categories={categories}
            fmt={fmt}
          />
        ))}
      </div>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Merchant</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Transactions</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="w-40">Confidence</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="w-20 pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <ReviewRowView
                key={`${r.id}-${r.categoryId}-${r.confidence}`}
                row={r}
                categories={categories}
                fmt={fmt}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function ReviewRowView({
  row,
  categories,
  fmt,
}: {
  row: ReviewRow
  categories: CategoryOption[]
  fmt: MoneyFormat
}) {
  const [categoryId, setCategoryId] = useState(row.categoryId)
  const { pending, execute } = useServerAction()
  const low = row.confidence < 70

  return (
    <TableRow>
      <TableCell className="max-w-xs pl-4">
        <div className="truncate font-medium capitalize" title={row.pattern}>
          {row.kind === "contains" ? `contains “${row.pattern}”` : row.pattern}
        </div>
        <div className="truncate text-xs text-muted-foreground" title={row.example}>
          {row.example}
        </div>
        {row.reason && row.source === "ai" && (
          <div className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
            <SparkleIcon className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2">{row.reason}</span>
          </div>
        )}
        {row.note && (
          <div className="mt-0.5 flex items-start gap-1 text-xs text-foreground/80">
            <NoteIcon className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2 whitespace-pre-line">{row.note}</span>
          </div>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={row.source === "ai" ? "secondary" : "outline"}>
          {SOURCE_LABEL[row.source]}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <Link href={`/transactions?rule=${row.id}`} className="underline-offset-4 hover:underline">
          {row.txCount}
        </Link>
        {row.autoCount < row.txCount && (
          <span className="text-xs text-muted-foreground" title="Some were set by you">
            {" "}
            ({row.autoCount} auto)
          </span>
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMoney(row.total, fmt, { signed: true })}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Progress
            value={row.confidence}
            aria-label="Confidence"
            className={cn("flex-1", low && "[&_[data-slot=progress-indicator]]:bg-destructive")}
          />
          <span className={cn("w-10 text-right text-xs tabular-nums", low && "text-destructive")}>
            {row.confidence}%
          </span>
        </div>
      </TableCell>
      <TableCell>
        <CategoryPicker
          size="sm"
          className="w-48"
          categories={categories}
          value={categoryId}
          disabled={pending}
          onValueChange={(next) => {
            if (next === null || next === categoryId) return
            const prev = categoryId
            setCategoryId(next)
            execute(() => recategorizeRule(row.id, next), {
              success: (r) => `Moved ${r.updated} transactions. Future imports will follow.`,
              onError: () => setCategoryId(prev),
            })
          }}
        />
      </TableCell>
      <TableCell className="pr-4">
        <div className="flex items-center justify-end gap-1">
          <NoteEditor ruleId={row.id} merchant={row.pattern} note={row.note} />
          {row.confidence < 100 && (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={`Confirm ${row.pattern}`}
            title="Looks right: set confidence to 100%"
            onClick={() => execute(() => confirmRule(row.id), { success: "Confirmed" })}
          >
              <CheckIcon />
          </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

type UncategorizedRow = { key: string; example: string; count: number; total: number }

export function UncategorizedTable({
  rows,
  categories,
  fmt,
}: {
  rows: UncategorizedRow[]
  categories: CategoryOption[]
  fmt: MoneyFormat
}) {
  return (
    <>
      <div className="grid divide-y md:hidden">
        {rows.map((r) => (
          <UncategorizedCard key={r.key} row={r} categories={categories} fmt={fmt} />
        ))}
      </div>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Merchant</TableHead>
              <TableHead className="text-right">Transactions</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="pr-4">Category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <UncategorizedRowView key={r.key} row={r} categories={categories} fmt={fmt} />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function UncategorizedRowView({
  row,
  categories,
  fmt,
}: {
  row: UncategorizedRow
  categories: CategoryOption[]
  fmt: MoneyFormat
}) {
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const { pending, execute } = useServerAction()
  return (
    <TableRow>
      <TableCell className="max-w-xs pl-4">
        <div className="truncate font-medium capitalize" title={row.key}>
          {row.key}
        </div>
        <div className="truncate text-xs text-muted-foreground" title={row.example}>
          {row.example}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.count}</TableCell>
      <TableCell className="text-right whitespace-nowrap tabular-nums">
        {formatMoney(row.total, fmt, { signed: true })}
      </TableCell>
      <TableCell className="pr-4">
        <CategoryPicker
          size="sm"
          className="w-48 border-dashed"
          categories={categories}
          value={categoryId}
          placeholder="Choose…"
          disabled={pending}
          onValueChange={(next) => {
            if (next === null) return
            setCategoryId(next)
            execute(() => categorizeMerchant(row.key, next), {
              success: (r) => `Categorized ${r.updated} transactions`,
              onError: () => setCategoryId(null),
            })
          }}
        />
      </TableCell>
    </TableRow>
  )
}

function ReviewCard({
  row,
  categories,
  fmt,
}: {
  row: ReviewRow
  categories: CategoryOption[]
  fmt: MoneyFormat
}) {
  const [categoryId, setCategoryId] = useState(row.categoryId)
  const { pending, execute } = useServerAction()
  const low = row.confidence < 70
  return (
    <div className="grid gap-2 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium break-words capitalize">
            {row.kind === "contains" ? `contains “${row.pattern}”` : row.pattern}
          </div>
          <div className="truncate text-xs text-muted-foreground">{row.example}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <NoteEditor ruleId={row.id} merchant={row.pattern} note={row.note} />
          {row.confidence < 100 && (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              aria-label={`Confirm ${row.pattern}`}
              onClick={() => execute(() => confirmRule(row.id), { success: "Confirmed" })}
            >
              <CheckIcon />
            </Button>
          )}[min(20rem,calc(100vw-2rem))]
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Badge variant={row.source === "ai" ? "secondary" : "outline"}>{SOURCE_LABEL[row.source]}</Badge>
        <Link href={`/transactions?rule=${row.id}`} className="underline-offset-4 hover:underline">
          {row.txCount} transactions
        </Link>
        <span className="tabular-nums">{formatMoney(row.total, fmt, { signed: true })}</span>
        <span className={cn("tabular-nums", low && "text-destructive")}>{row.confidence}%</span>
      </div>
      {row.reason && row.source === "ai" && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{row.reason}</p>
      )}
      <CategoryPicker
        size="sm"
        className="w-full"
        categories={categories}
        value={categoryId}
        disabled={pending}
        onValueChange={(next) => {
          if (next === null || next === categoryId) return
          const prev = categoryId
          setCategoryId(next)
          execute(() => recategorizeRule(row.id, next), {
            success: (r) => `Moved ${r.updated} transactions. Future imports will follow.`,
            onError: () => setCategoryId(prev),
          })
        }}
      />
    </div>
  )
}

function UncategorizedCard({
  row,
  categories,
  fmt,
}: {
  row: UncategorizedRow
  categories: CategoryOption[]
  fmt: MoneyFormat
}) {
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const { pending, execute } = useServerAction()
  return (
    <div className="grid gap-2 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium break-words capitalize">{row.key}</div>
          <div className="truncate text-xs text-muted-foreground">{row.example}</div>
        </div>
        <div className="shrink-0 text-right text-sm">
          <div className="font-medium tabular-nums">{formatMoney(row.total, fmt, { signed: true })}</div>
          <div className="text-xs text-muted-foreground">{row.count} transactions</div>
        </div>
      </div>
      <CategoryPicker
        size="sm"
        className="w-full border-dashed"
        categories={categories}
        value={categoryId}
        placeholder="Choose…"
        disabled={pending}
        onValueChange={(next) => {
          if (next === null) return
          setCategoryId(next)
          execute(() => categorizeMerchant(row.key, next), {
            success: (r) => `Categorized ${r.updated} transactions`,
            onError: () => setCategoryId(null),
          })
        }}
      />
    </div>
  )
}

function NoteEditor({
  ruleId,
  merchant,
  note,
}: {
  ruleId: number
  merchant: string
  note: string | null
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note ?? "")
  const { pending, execute } = useServerAction()
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setDraft(note ?? "")
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={note ? `Edit note for ${merchant}` : `Add note for ${merchant}`}
            title={note ? "Edit note" : "Add note"}
            className={note ? "text-foreground" : "text-muted-foreground"}
          />
        }
      >
        <NotePencilIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3">
        <div className="font-medium capitalize">{merchant}</div>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            execute(() => setRuleNote(ruleId, draft), {
              success: draft.trim() ? "Note saved" : "Note removed",
              onSuccess: () => setOpen(false),
            })
          }}
        >
          <Textarea
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Kids' swimming lessons, paid termly"
            aria-label="Note"
          />
          <div className="flex justify-end gap-2">
            {note && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  execute(() => setRuleNote(ruleId, ""), {
                    success: "Note removed",
                    onSuccess: () => setOpen(false),
                  })
                }
              >
                Remove
              </Button>
            )}
            <Button type="submit" size="sm" disabled={pending}>
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
