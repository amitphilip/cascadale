"use client"

import { useState } from "react"

import {
  resetCategoryProjection,
  resetRecurringOverride,
  saveCategoryProjection,
  saveRecurringOverride,
} from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useServerAction } from "@/hooks/use-server-action"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import {
  BASIS_DESCRIPTIONS,
  BASIS_LABELS,
  growthFactor,
  type DefaultBasis,
  type RecurringBasis,
} from "@/lib/recurring"

/** What the dialog edits: a whole category, or one merchant within it. */
export type ProjectionTarget =
  | { kind: "category"; categoryId: number; name: string }
  | { kind: "series"; key: string; name: string; excluded: boolean }

export type ProjectionSaved = {
  basis: RecurringBasis | null
  growthRate: number | null
  amount: number | null
}

const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`
const pctInput = (rate: number | null) =>
  rate == null ? "" : String(Math.round(rate * 1000) / 10)

export function ProjectionDialog({
  target,
  saved,
  inherited,
  inheritedFrom,
  inheritedRate,
  previews,
  fmt,
  trigger,
}: {
  target: ProjectionTarget
  saved: ProjectionSaved | null
  /** the basis used when nothing is set here */
  inherited: DefaultBasis
  /** where the inherited basis comes from, e.g. "page default" or "Insurance" */
  inheritedFrom: string
  /** the growth rate used when none is set here */
  inheritedRate: number
  /** monthly projection on each basis, with the inherited growth rate */
  previews: Record<DefaultBasis, number>
  fmt: MoneyFormat
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [basis, setBasis] = useState<RecurringBasis | "default">(
    saved?.basis ?? "default"
  )
  const [growth, setGrowth] = useState(pctInput(saved?.growthRate ?? null))
  const { pending, execute } = useServerAction()

  const rate =
    growth === "" || !Number.isFinite(Number(growth))
      ? inheritedRate
      : Number(growth) / 100
  // a typed rate applies uniformly, so it compounds the latest figure directly
  const preview = {
    ...previews,
    growth:
      growth === "" ? previews.growth : previews.latest * growthFactor(rate),
  }
  const money = (n: number) => `${formatMoney(n, fmt)}/mo`
  const items = [
    {
      value: "default",
      label: `${BASIS_LABELS[inherited]}, from ${inheritedFrom}`,
    },
    ...(["latest", "average", "growth"] as const).map((b) => ({
      value: b,
      label: `${BASIS_LABELS[b]} · ${money(preview[b])}`,
    })),
    { value: "custom", label: "Custom amount" },
  ]
  const effective = basis === "default" ? inherited : basis
  const isCategory = target.kind === "category"

  function reset() {
    setBasis(saved?.basis ?? "default")
    setGrowth(pctInput(saved?.growthRate ?? null))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) reset()
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form
          key={JSON.stringify(saved)}
          action={(form) =>
            execute(
              () =>
                isCategory
                  ? saveCategoryProjection(form)
                  : saveRecurringOverride(form),
              { success: "Projection updated", onSuccess: () => setOpen(false) }
            )
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>Project “{target.name}”</DialogTitle>
            <DialogDescription>
              {isCategory
                ? "Sets the basis for the whole category. Merchants with their own setting keep it."
                : "Sets the basis for this merchant only, overriding its category."}
            </DialogDescription>
          </DialogHeader>
          {target.kind === "category" ? (
            <input type="hidden" name="categoryId" value={target.categoryId} />
          ) : (
            <input type="hidden" name="key" value={target.key} />
          )}
          <FieldGroup>
            <Field>
              <FieldLabel>Basis</FieldLabel>
              <Select
                name="basis"
                items={items}
                value={basis}
                onValueChange={(v) => setBasis(v as RecurringBasis | "default")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {BASIS_DESCRIPTIONS[effective]}.
              </FieldDescription>
            </Field>
            {effective === "growth" ? (
              <Field>
                <FieldLabel htmlFor="proj-growth">
                  Growth per year (%)
                </FieldLabel>
                <Input
                  id="proj-growth"
                  name="growthRate"
                  type="number"
                  step="0.1"
                  value={growth}
                  onChange={(e) => setGrowth(e.target.value)}
                  placeholder={pctInput(inheritedRate)}
                />
                <FieldDescription>
                  {isCategory
                    ? `Applies to every merchant in the category. Leave blank to use each one's detected trend (${pct(inheritedRate)} for the category overall).`
                    : `Leave blank to use ${pct(inheritedRate)}.`}{" "}
                  Projects {money(preview.growth)}.
                </FieldDescription>
              </Field>
            ) : (
              // keep the saved rate when another basis is chosen
              <input type="hidden" name="growthRate" value={growth} />
            )}
            {basis === "custom" && (
              <Field>
                <FieldLabel htmlFor="proj-amount">Monthly amount</FieldLabel>
                <Input
                  id="proj-amount"
                  name="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  defaultValue={
                    saved?.amount ?? Math.round(previews[inherited] * 100) / 100
                  }
                />
              </Field>
            )}
            {target.kind === "series" && (
              <Field orientation="horizontal">
                <Checkbox
                  id="proj-excluded"
                  name="excluded"
                  defaultChecked={target.excluded}
                />
                <FieldLabel htmlFor="proj-excluded" className="font-normal">
                  Not recurring: count it with the category&rsquo;s other
                  spending
                </FieldLabel>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            {saved && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  execute(
                    () =>
                      target.kind === "category"
                        ? resetCategoryProjection(target.categoryId)
                        : resetRecurringOverride(target.key),
                    {
                      success: `Reset to ${inheritedFrom}`,
                      onSuccess: () => setOpen(false),
                    }
                  )
                }
              >
                Reset
              </Button>
            )}
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
