"use client"

import { useState } from "react"

import { saveAccount } from "@/app/actions"
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
import { ACCOUNT_TYPES, type Account } from "@/lib/db/schema"
import { ACCOUNT_TYPE_LABELS } from "@/lib/format"

const typeItems = ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))

export function AccountDialog({
  account,
  trigger,
  onSaved,
}: {
  account?: Pick<Account, "id" | "name" | "type" | "institution" | "openingBalance">
  trigger: React.ReactElement
  onSaved?: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form
          // Remount when the record changes so default values stay in sync.
          key={JSON.stringify(account ?? null)}
          action={(form) =>
            execute(() => saveAccount(form), {
              success: account ? "Account updated" : "Account added",
              onSuccess: (r) => {
                setOpen(false)
                onSaved?.(r.id)
              },
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>{account ? "Edit account" : "Add account"}</DialogTitle>
            <DialogDescription>
              Bank accounts, cards, loans, wallets — anything that holds a balance.
            </DialogDescription>
          </DialogHeader>
          {account && <input type="hidden" name="id" value={account.id} />}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="acc-name">Name</FieldLabel>
              <Input
                id="acc-name"
                name="name"
                required
                defaultValue={account?.name}
                placeholder="Everyday checking"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Select name="type" items={typeItems} defaultValue={account?.type ?? "checking"}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {typeItems.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="acc-inst">Institution</FieldLabel>
                <Input
                  id="acc-inst"
                  name="institution"
                  defaultValue={account?.institution ?? ""}
                  placeholder="Optional"
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="acc-open">Opening balance</FieldLabel>
              <Input
                id="acc-open"
                name="openingBalance"
                type="number"
                step="0.01"
                defaultValue={account?.openingBalance ?? 0}
              />
              <FieldDescription>
                Balance before the first transaction you import. Use a negative number for
                amounts owed (cards, loans).
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {account ? "Save changes" : "Add account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
