"use client"

import { useState } from "react"

import { saveUpcomingExpense } from "@/app/actions"
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

export type UpcomingDraft = {
  id: number
  name: string
  amount: number
  dueDate: string
  accountId: number | null
  note: string | null
}

const NONE = "none"

export function UpcomingDialog({
  expense,
  accounts,
  trigger,
}: {
  expense?: UpcomingDraft
  accounts: { id: number; name: string }[]
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()
  const accountItems = [
    { value: NONE, label: "Not decided" },
    ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-lg">
        <form
          key={JSON.stringify(expense ?? null)}
          action={(form) =>
            execute(() => saveUpcomingExpense(form), {
              success: expense
                ? "Upcoming expense updated"
                : "Upcoming expense added",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>
              {expense ? "Edit upcoming expense" : "Add upcoming expense"}
            </DialogTitle>
            <DialogDescription>
              A one-off cost you know is coming. Projections and check-ins plan
              around it.
            </DialogDescription>
          </DialogHeader>
          {expense && <input type="hidden" name="id" value={expense.id} />}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="up-name">What for</FieldLabel>
              <Input
                id="up-name"
                name="name"
                required
                defaultValue={expense?.name}
                placeholder="Car service"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="up-amount">Amount</FieldLabel>
                <Input
                  id="up-amount"
                  name="amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  required
                  defaultValue={expense?.amount}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="up-date">Due</FieldLabel>
                <Input
                  id="up-date"
                  name="dueDate"
                  type="date"
                  required
                  defaultValue={expense?.dueDate}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Paid from</FieldLabel>
              <Select
                name="accountId"
                items={accountItems}
                defaultValue={
                  expense?.accountId ? String(expense.accountId) : NONE
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
              <FieldDescription>
                Undecided costs come out of your largest cash account.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="up-note">Note (optional)</FieldLabel>
              <Input
                id="up-note"
                name="note"
                defaultValue={expense?.note ?? ""}
                placeholder="Could slip to December"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : expense ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
