"use client"

import { useState } from "react"
import { ArrowsLeftRightIcon, CaretDownIcon, CheckCircleIcon, SparkleIcon } from "@phosphor-icons/react"

import { moveTransaction, updateCas, type MoveTarget } from "@/app/actions"
import { CategoryPicker, type CategoryOption } from "@/components/category-picker"
import { Meter } from "@/components/meter"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useServerAction } from "@/hooks/use-server-action"
import type { MonthFigures, TrackGroup, TrackRow } from "@/lib/month-figures"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import type { SpendTx } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { merchantName } from "@/supabase/functions/_shared/cas-queue"
import { merchantKey } from "@/lib/rules"

const EYEBROW = "text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase"

const GROUPS: { group: TrackGroup; title: string }[] = [
  { group: "everyday", title: "Everyday" },
  { group: "bills", title: "Bills and regular payments" },
  { group: "one_offs", title: "One-off payments" },
]

export type OneOffOption = { id: number; name: string; accountId: number }

export function BudgetTracking({
  figures,
  categories,
  oneOffs,
  accounts,
  waiting,
  fmt,
}: {
  figures: MonthFigures
  categories: CategoryOption[]
  oneOffs: OneOffOption[]
  accounts: { id: number; name: string }[]
  /** corrections still waiting for Cas */
  waiting: number
  fmt: MoneyFormat
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [moving, setMoving] = useState<SpendTx | null>(null)
  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const lts = figures.leftToSpend
  const accountName = new Map(accounts.map((a) => [a.id, a.name]))

  return (
    <div className="grid gap-5">
      {lts.budgeted > 0 && (
        <p className="text-sm text-pretty">
          <span className={cn("font-semibold tabular-nums", lts.amount < 0 && "text-destructive")}>
            {lts.amount < 0 ? `${money(-lts.amount)} over` : `${money(lts.amount)} left`}
          </span>{" "}
          <span className="text-muted-foreground">
            of {money(lts.budgeted)} for everyday spending
            {lts.perDay > 0 && `, about ${money(lts.perDay)} a day for ${figures.month.daysLeft} days`}.
            {lts.unbudgeted > 0 && ` Includes ${money(lts.unbudgeted)} spent with no budget.`}
          </span>
        </p>
      )}

      <CasQueue waiting={waiting} />

      {GROUPS.map(({ group, title }) => {
        const rows = figures.rows.filter((r) => r.group === group)
        if (rows.length === 0) return null
        return (
          <section key={group} className="grid gap-1" aria-label={title}>
            <h3 className={EYEBROW}>{title}</h3>
            <ul className="-mx-2 grid">
              {rows.map((row) => (
                <li key={row.key}>
                  <TrackRowView
                    row={row}
                    open={open === row.key}
                    onToggle={() => setOpen(open === row.key ? null : row.key)}
                    onMove={setMoving}
                    accountName={accountName}
                    fmt={fmt}
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      <MoveDialog
        tx={moving}
        onClose={() => setMoving(null)}
        categories={categories}
        oneOffs={oneOffs}
        accountName={accountName}
        fmt={fmt}
      />
    </div>
  )
}

/** How many changes are waiting for Cas, and taking them in now. */
function CasQueue({ waiting }: { waiting: number }) {
  const { execute, pending } = useServerAction()
  if (waiting === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-positive" aria-hidden />
        Cas is up to date with your changes.
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/8 px-4 py-3">
      <p className="text-sm text-pretty">
        <span className="font-semibold">
          {waiting} change{waiting === 1 ? "" : "s"} waiting for Cas.
        </span>{" "}
        <span className="text-muted-foreground">It takes them in each morning.</span>
      </p>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          execute(() => updateCas(), {
            success: (r) =>
              r.rules > 0
                ? `Cas took in ${r.processed} change${r.processed === 1 ? "" : "s"} and set ${r.rules} merchant rule${r.rules === 1 ? "" : "s"}${r.recategorized ? `, moving ${r.recategorized} more transactions` : ""}`
                : `Cas took in ${r.processed} change${r.processed === 1 ? "" : "s"}`,
          })
        }
      >
        <SparkleIcon data-icon="inline-start" />
        {pending ? "Updating…" : "Update Cas now"}
      </Button>
    </div>
  )
}

function TrackRowView({
  row,
  open,
  onToggle,
  onMove,
  accountName,
  fmt,
}: {
  row: TrackRow
  open: boolean
  onToggle: () => void
  onMove: (tx: SpendTx) => void
  accountName: Map<number, string>
  fmt: MoneyFormat
}) {
  const [merchant, setMerchant] = useState<string | null>(null)
  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const exact = (n: number) => formatMoney(n, fmt)
  const over = row.budget !== null && row.spent > row.budget
  const tone = row.pace === "over" ? "destructive" : row.pace === "ahead" ? "warning" : "positive"
  const panel = `track-${row.key}`

  const summary =
    row.group === "one_offs"
      ? row.due > 0
        ? `${money(row.spent)} paid · ${money(row.due)} still to pay this month`
        : `${money(row.spent)} paid this month`
      : [
          row.budget !== null ? `${money(row.spent)} of ${money(row.budget)} this ${row.period}` : `${money(row.spent)} this month · no budget`,
          row.due > 0 ? `${money(row.due)} still due` : null,
        ]
          .filter(Boolean)
          .join(" · ")

  return (
    <div className={cn("rounded-lg transition-colors", open && "bg-muted/50")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panel}
        className="grid w-full gap-2 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-muted/60"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <CaretDownIcon
              aria-hidden
              className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
            />
            <span className="truncate">{row.name}</span>
          </span>
          {row.budget !== null && row.group !== "one_offs" ? (
            <span
              className={cn(
                "shrink-0 text-sm font-semibold tabular-nums",
                over ? "text-destructive" : row.pace === "ahead" && "text-warning"
              )}
            >
              {over ? `${money(row.spent - row.budget)} over` : `${money(row.budget - row.spent)} left`}
            </span>
          ) : (
            <span className="shrink-0 text-sm font-semibold tabular-nums">{money(row.spent)}</span>
          )}
        </span>
        {row.budget !== null && row.budget > 0 && (
          <Meter
            value={row.spent}
            max={row.budget}
            // bills land on their own dates, so only everyday spending has a pace to keep
            mark={row.group === "everyday" && row.expected !== null ? row.expected / row.budget : undefined}
            tone={row.group === "one_offs" ? "primary" : tone}
            label={summary}
          />
        )}
        <span className="pl-5 text-xs text-muted-foreground tabular-nums">{summary}</span>
      </button>

      {open && (
        <div id={panel} className="grid gap-0.5 px-2 pb-3">
          {row.merchants.length === 0 ? (
            <p className="py-2 pl-5 text-sm text-muted-foreground">Nothing spent yet this {row.period}.</p>
          ) : (
            <ul className="grid">
              {row.merchants.map((m) => {
                const expanded = merchant === m.key
                return (
                  <li key={m.key} className="pl-5">
                    <button
                      type="button"
                      onClick={() => setMerchant(expanded ? null : m.key)}
                      aria-expanded={expanded}
                      className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-background/70"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <CaretDownIcon
                          aria-hidden
                          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")}
                        />
                        <span className="truncate">{m.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">×{m.txs.length}</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">{exact(m.spent)}</span>
                    </button>
                    {expanded && (
                      <ul className="grid gap-px pb-1 pl-6">
                        {m.txs.map((t) => (
                          <li
                            key={t.id}
                            className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-background/70"
                          >
                            <span className="grid min-w-0">
                              <span className="truncate">{t.description}</span>
                              <span className="text-xs text-muted-foreground">
                                {formatDate(t.date, fmt.locale)} · {accountName.get(t.accountId) ?? "Account"}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              <span className={cn("tabular-nums", t.amount > 0 && "text-positive")}>
                                {formatMoney(t.amount, fmt, { signed: t.amount > 0 })}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onMove(t)}
                                aria-label={`Move ${t.description}`}
                                className="max-sm:size-11 max-sm:px-0"
                              >
                                <ArrowsLeftRightIcon data-icon="inline-start" className="max-sm:mr-0" />
                                <span className="max-sm:sr-only">Move</span>
                              </Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Move one transaction to another category, or to count towards a one-off payment. */
function MoveDialog({
  tx,
  onClose,
  categories,
  oneOffs,
  accountName,
  fmt,
}: {
  tx: SpendTx | null
  onClose: () => void
  categories: CategoryOption[]
  oneOffs: OneOffOption[]
  accountName: Map<number, string>
  fmt: MoneyFormat
}) {
  return (
    <Dialog open={tx !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {/* keyed so each transaction starts from its own category */}
        {tx && <MoveForm key={tx.id} tx={tx} onDone={onClose} categories={categories} oneOffs={oneOffs} accountName={accountName} fmt={fmt} />}
      </DialogContent>
    </Dialog>
  )
}

function MoveForm({
  tx,
  onDone,
  categories,
  oneOffs,
  accountName,
  fmt,
}: {
  tx: SpendTx
  onDone: () => void
  categories: CategoryOption[]
  oneOffs: OneOffOption[]
  accountName: Map<number, string>
  fmt: MoneyFormat
}) {
  const [mode, setMode] = useState<"category" | "one_off">(tx.oneOffId !== null ? "one_off" : "category")
  const [categoryId, setCategoryId] = useState<number | null>(tx.categoryId)
  const usable = oneOffs.filter((o) => o.accountId === tx.accountId)
  const [oneOffId, setOneOffId] = useState<number | null>(tx.oneOffId ?? usable[0]?.id ?? null)
  const [remember, setRemember] = useState(false)
  const { execute, pending } = useServerAction()
  const merchant = merchantName(merchantKey(tx.description))

  const unchanged =
    mode === "category" ? tx.oneOffId === null && categoryId === tx.categoryId : oneOffId === null || oneOffId === tx.oneOffId
  const target: MoveTarget | null =
    mode === "category" ? { categoryId } : oneOffId !== null ? { oneOffId } : null

  return (
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault()
        if (!target || unchanged) return
        execute(() => moveTransaction(tx.id, target, mode === "category" && remember), {
          success: (r) =>
            r.queued ? "Moved. Cas will take it in with its next update." : "Moved back where it was.",
          onSuccess: onDone,
        })
      }}
    >
      <DialogHeader>
        <DialogTitle>Move this transaction</DialogTitle>
        <DialogDescription className="grid gap-0.5">
          <span className="font-medium text-foreground">{tx.description}</span>
          <span className="tabular-nums">
            {formatMoney(tx.amount, fmt)} · {formatDate(tx.date, fmt.locale)} · {accountName.get(tx.accountId) ?? "Account"}
          </span>
        </DialogDescription>
      </DialogHeader>

      <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
        <TabsList className="w-full">
          <TabsTrigger value="category">Category</TabsTrigger>
          <TabsTrigger value="one_off">One-off payment</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "category" ? (
        <div className="grid gap-4">
          <Field>
            <FieldLabel>Category</FieldLabel>
            <CategoryPicker categories={categories} value={categoryId} onValueChange={setCategoryId} className="w-full" />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="move-remember" checked={remember} onCheckedChange={(v) => setRemember(Boolean(v))} />
            <div className="grid gap-1">
              <FieldLabel htmlFor="move-remember" className="font-normal">
                Do this for every {merchant}
              </FieldLabel>
              <FieldDescription>
                Cas makes it the rule when it takes in your changes. Leave it off for a one-time move.
              </FieldDescription>
            </div>
          </Field>
        </div>
      ) : usable.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {oneOffs.length === 0
            ? "There are no one-off payments yet. Add one on the One-offs page."
            : `None of your one-off payments is paid from ${accountName.get(tx.accountId) ?? "this account"}, and only a one-off's own account counts towards it.`}
        </p>
      ) : (
        <Field>
          <FieldLabel>Counts towards</FieldLabel>
          <Select
            items={usable.map((o) => ({ value: String(o.id), label: o.name }))}
            value={oneOffId === null ? null : String(oneOffId)}
            onValueChange={(v) => setOneOffId(v == null ? null : Number(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {usable.map((o) => (
                <SelectItem key={o.id} value={String(o.id)}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            It comes out of the budgets and counts as paid for the one-off. {merchant}&rsquo;s other transactions stay
            as they are.
          </FieldDescription>
        </Field>
      )}

      <DialogFooter>
        <Button type="submit" disabled={pending || unchanged || !target} className="max-sm:w-full">
          {pending ? "Moving…" : "Move"}
        </Button>
      </DialogFooter>
    </form>
  )
}
