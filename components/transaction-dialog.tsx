"use client"

import { useState } from "react"

import { saveTransaction } from "@/app/actions"
import { CategoryPicker, type CategoryOption } from "@/components/category-picker"
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useServerAction } from "@/hooks/use-server-action"

export type TransactionDraft = {
  id: number
  accountId: number
  date: string
  description: string
  amount: number
  categoryId: number | null
  notes: string | null
}

const directionItems = [
  { value: "out", label: "Money out" },
  { value: "in", label: "Money in" },
]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function TransactionDialog({
  transaction,
  accounts,
  categories,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  transaction?: TransactionDraft
  accounts: { id: number; name: string }[]
  categories: CategoryOption[]
  trigger?: React.ReactElement
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const [direction, setDirection] = useState(
    transaction && transaction.amount > 0 ? "in" : "out"
  )
  const { pending, execute } = useServerAction()
  const accountItems = accounts.map((a) => ({ value: String(a.id), label: a.name }))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className="sm:max-w-lg">
        <form
          // Remount when the record changes so default values stay in sync.
          key={JSON.stringify(transaction ?? null)}
          action={(form) => {
            const abs = Math.abs(Number(form.get("absAmount")))
            form.set("amount", String(direction === "out" ? -abs : abs))
            execute(() => saveTransaction(form), {
              success: transaction ? "Transaction updated" : "Transaction added",
              onSuccess: () => setOpen(false),
            })
          }}
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>{transaction ? "Edit transaction" : "Add transaction"}</DialogTitle>
            <DialogDescription>
              {transaction
                ? "Correct details, recategorize, or add a note."
                : "Record cash spending or anything missing from your statements."}
            </DialogDescription>
          </DialogHeader>
          {transaction && <input type="hidden" name="id" value={transaction.id} />}
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Account</FieldLabel>
                <Select
                  name="accountId"
                  items={accountItems}
                  required
                  defaultValue={
                    transaction ? String(transaction.accountId) : accountItems[0]?.value
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accountItems.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="tx-date">Date</FieldLabel>
                <Input
                  id="tx-date"
                  name="date"
                  type="date"
                  required
                  defaultValue={transaction?.date ?? today()}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="tx-desc">Description</FieldLabel>
              <Input
                id="tx-desc"
                name="description"
                required
                defaultValue={transaction?.description}
                placeholder="Farmers market"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Direction</FieldLabel>
                <Select
                  items={directionItems}
                  value={direction}
                  onValueChange={(v) => setDirection(v as string)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {directionItems.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="tx-amount">Amount</FieldLabel>
                <Input
                  id="tx-amount"
                  name="absAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  defaultValue={transaction ? Math.abs(transaction.amount) : undefined}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Category</FieldLabel>
              <CategoryPicker
                name="categoryId"
                categories={categories}
                defaultValue={transaction?.categoryId ?? null}
                className="w-full"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="tx-notes">Notes</FieldLabel>
              <Textarea
                id="tx-notes"
                name="notes"
                rows={2}
                defaultValue={transaction?.notes ?? ""}
                placeholder="Optional context for future you"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || accounts.length === 0}>
              {transaction ? "Save changes" : "Add transaction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
