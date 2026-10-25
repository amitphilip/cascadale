"use client"

import { useState } from "react"

import { saveCategory } from "@/app/actions"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useServerAction } from "@/hooks/use-server-action"
import { CATEGORY_KINDS, type Category } from "@/lib/db/schema"
import { CATEGORY_KIND_LABELS } from "@/lib/format"

const kindItems = CATEGORY_KINDS.map((k) => ({ value: k, label: CATEGORY_KIND_LABELS[k] }))

export function CategoryDialog({
  category,
  trigger,
}: {
  category?: Pick<Category, "id" | "name" | "kind" | "monthlyBudget">
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form
          // Remount when the record changes so default values stay in sync.
          key={JSON.stringify(category ?? null)}
          action={(form) =>
            execute(() => saveCategory(form), {
              success: category ? "Category updated" : "Category added",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>{category ? "Edit category" : "Add category"}</DialogTitle>
            <DialogDescription>
              Transfers are excluded from income and spending totals.
            </DialogDescription>
          </DialogHeader>
          {category && <input type="hidden" name="id" value={category.id} />}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cat-name">Name</FieldLabel>
              <Input id="cat-name" name="name" required defaultValue={category?.name} />
            </Field>
            <Field>
              <FieldLabel>Kind</FieldLabel>
              <Select name="kind" items={kindItems} defaultValue={category?.kind ?? "expense"}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kindItems.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="cat-budget">Monthly budget</FieldLabel>
              <Input
                id="cat-budget"
                name="monthlyBudget"
                type="number"
                step="0.01"
                min="0"
                defaultValue={category?.monthlyBudget ?? ""}
                placeholder="No budget"
              />
              <FieldDescription>Only used for expense categories.</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {category ? "Save changes" : "Add category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
