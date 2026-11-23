"use client"

import { useState } from "react"
import { PencilSimpleIcon } from "@phosphor-icons/react"

import { setCategoryBudgets } from "@/app/actions"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useServerAction } from "@/hooks/use-server-action"
import type { BudgetPeriod } from "@/lib/db/schema"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import { cn } from "@/lib/utils"

type Budget = { categoryId: number; amount: number }

const WEEKS_PER_MONTH = 52 / 12
const SUFFIX: Record<BudgetPeriod, string> = { week: "/wk", month: "/mo" }

/** A category's budget as saved: its amount for its period, and its percent if it's one. */
export type SavedBudget = {
  period: BudgetPeriod
  /** for its period */
  amount: number
  percent: number | null
} | null

/**
 * The budget cell: shows the budget and opens an editor to set it as an amount or as a
 * percentage of projected income, weekly or monthly.
 */
export function BudgetEditor({
  categoryId,
  name,
  saved,
  projected,
  monthlyIncome,
  fmt,
}: {
  categoryId: number
  name: string
  saved: SavedBudget
  /** the category's projected monthly spend */
  projected: number
  /** projected monthly income, the base for a percentage; null before there's any */
  monthlyIncome: number | null
  fmt: MoneyFormat
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"amount" | "percent">("amount")
  const [period, setPeriod] = useState<BudgetPeriod>("month")
  const [value, setValue] = useState("")
  const { pending, execute } = useServerAction()

  const perPeriod = (monthly: number, p: BudgetPeriod) => (p === "week" ? monthly / WEEKS_PER_MONTH : monthly)
  const money = (n: number, p: BudgetPeriod) => `${formatMoney(n, fmt)}${SUFFIX[p]}`
  const income = monthlyIncome ?? 0
  const canPercent = income > 0

  function reset() {
    const p = saved?.period ?? "month"
    setPeriod(p)
    if (saved?.percent != null) {
      setMode("percent")
      setValue(String(saved.percent))
    } else {
      setMode("amount")
      setValue(saved ? String(saved.amount) : String(Math.round(perPeriod(projected, p))))
    }
  }

  const n = Number(value)
  const valid = value.trim() !== "" && Number.isFinite(n) && n > 0 && (mode === "amount" || n <= 100)
  // what the budget comes to for the chosen period
  const amount = !valid ? null : mode === "amount" ? n : perPeriod((income * n) / 100, period)
  const share = amount !== null && income > 0 ? (amount / perPeriod(income, period)) * 100 : null

  function switchMode(next: "amount" | "percent") {
    if (next === mode) return
    // carry the figure across so the budget stays the same until it's changed
    if (valid && amount !== null) {
      setValue(
        next === "percent"
          ? String(Math.round((amount / perPeriod(income, period)) * 1000) / 10)
          : String(Math.round(amount))
      )
    }
    setMode(next)
  }

  function save(input: { amount?: number; percent?: number; period: BudgetPeriod }, success: string) {
    execute(() => setCategoryBudgets([{ categoryId, ...input }]), {
      success,
      onSuccess: () => setOpen(false),
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 h-auto min-h-8 gap-1.5 px-2 py-1 text-right max-sm:min-h-11"
            aria-label={`Edit ${name} budget`}
          />
        }
      >
        <span className="grid justify-items-end leading-tight">
          <span
            className={cn(
              "tabular-nums",
              !saved && "text-muted-foreground",
              saved && perPeriod(projected, saved.period) > saved.amount + 0.5 && "text-destructive"
            )}
            title={saved && perPeriod(projected, saved.period) > saved.amount + 0.5 ? "Budget is below the projection" : undefined}
          >
            {saved ? (
              <>
                {/* phones hide the Budget column heading, so say it here */}
                <span className="font-normal text-muted-foreground sm:hidden">Budget </span>
                {money(saved.amount, saved.period)}
              </>
            ) : (
              <>
                Set<span className="sm:hidden"> budget</span>
              </>
            )}
          </span>
          {saved?.percent != null && (
            <span className="text-xs font-normal text-muted-foreground">{saved.percent}% of income</span>
          )}
        </span>
        <PencilSimpleIcon className="text-muted-foreground" />
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid) return
            save(
              mode === "amount" ? { amount: n, period } : { percent: n, period },
              `${name} budget set`
            )
          }}
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>Budget for “{name}”</DialogTitle>
            <DialogDescription>
              Projected at {money(perPeriod(projected, period), period)}.
              {canPercent && ` Projected income is ${money(perPeriod(income, period), period)}.`}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Set as</FieldLabel>
              <Tabs value={mode} onValueChange={(v) => switchMode(v as "amount" | "percent")}>
                <TabsList className="w-full">
                  <TabsTrigger value="amount">Amount</TabsTrigger>
                  <TabsTrigger value="percent" disabled={!canPercent}>
                    % of income
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {!canPercent && <FieldDescription>There&rsquo;s no projected income yet to take a percentage of.</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel>Every</FieldLabel>
              <Tabs value={period} onValueChange={(v) => setPeriod(v as BudgetPeriod)}>
                <TabsList className="w-full">
                  <TabsTrigger value="week">Week</TabsTrigger>
                  <TabsTrigger value="month">Month</TabsTrigger>
                </TabsList>
              </Tabs>
              <FieldDescription>Weeks run Monday to Sunday.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`budget-${categoryId}`}>
                {mode === "amount" ? `Amount per ${period}` : "Percent of income"}
              </FieldLabel>
              <div className="relative">
                <Input
                  id={`budget-${categoryId}`}
                  type="number"
                  inputMode="decimal"
                  step={mode === "amount" ? "1" : "0.1"}
                  min="0"
                  max={mode === "percent" ? "100" : undefined}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className={cn("text-base", mode === "percent" && "pr-8")}
                  required
                />
                {mode === "percent" && (
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                    %
                  </span>
                )}
              </div>
              <FieldDescription>
                {amount === null
                  ? mode === "percent"
                    ? "Enter a percentage from 0.1 to 100."
                    : "Enter an amount above zero."
                  : mode === "percent"
                    ? `Comes to ${money(amount, period)} today, and follows your income as it changes.`
                    : share !== null
                      ? `${Math.round(share * 10) / 10}% of projected income.`
                      : null}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending || projected <= 0}
                onClick={() =>
                  save({ amount: perPeriod(projected, period), period }, `${name} budget set to its projection`)
                }
              >
                Use projection
              </Button>
              {saved && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => save({ amount: 0, period }, `${name} budget cleared`)}
                >
                  Clear
                </Button>
              )}
            </div>
            <Button type="submit" disabled={pending || !valid}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Sets every expense category's monthly budget to its projection. */
export function ApplyAllBudgetsButton({ budgets }: { budgets: Budget[] }) {
  const { pending, execute } = useServerAction()
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={pending || budgets.length === 0}>
          Set all budgets
        </Button>
      }
      title="Set budgets from projections?"
      description={`This replaces the budget on ${budgets.length} expense categories with their projected monthly amount, rounded to the nearest whole unit. Percentage budgets become fixed amounts. Categories projected at zero have their budget cleared.`}
      confirmLabel="Set budgets"
      destructive={false}
      onConfirm={() =>
        execute(() => setCategoryBudgets(budgets), {
          success: (r) => `Updated ${r.count} budgets`,
        })
      }
    />
  )
}
