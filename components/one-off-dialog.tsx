"use client"

import { useState } from "react"

import { saveOneOff } from "@/app/actions"
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
import type { OneOff, OneOffFrequency, OneOffOutMode } from "@/lib/db/schema"
import { FREQUENCY_LABELS } from "@/lib/one-offs"

export type OneOffDraft = Pick<
  OneOff,
  | "id"
  | "name"
  | "total"
  | "accountId"
  | "startDate"
  | "finishDate"
  | "outMode"
  | "outEvery"
  | "inEvery"
  | "setAside"
  | "note"
>

const FREQUENCIES = Object.entries(FREQUENCY_LABELS).map(([value, label]) => ({ value, label }))
const OUT_MODES = [
  { value: "single", label: "In one go, on the finish date" },
  { value: "spread", label: "In parts, until the finish date" },
]

function FrequencySelect({
  name,
  defaultValue,
}: {
  name: string
  defaultValue: OneOffFrequency
}) {
  return (
    <Select name={name} items={FREQUENCIES} defaultValue={defaultValue}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FREQUENCIES.map((f) => (
          <SelectItem key={f.value} value={f.value}>
            {f.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function OneOffDialog({
  oneOff,
  accounts,
  today,
  trigger,
}: {
  oneOff?: OneOffDraft
  accounts: { id: number; name: string }[]
  today: string
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [outMode, setOutMode] = useState<OneOffOutMode>(oneOff?.outMode ?? "single")
  const { pending, execute } = useServerAction()
  const accountItems = accounts.map((a) => ({ value: String(a.id), label: a.name }))

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        setOpen(o)
        if (o) setOutMode(oneOff?.outMode ?? "single")
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-lg">
        <form
          key={JSON.stringify(oneOff ?? null)}
          action={(form) =>
            execute(() => saveOneOff(form), {
              success: oneOff ? "One-off payment updated" : "One-off payment added",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>{oneOff ? "Edit one-off payment" : "Add one-off payment"}</DialogTitle>
            <DialogDescription>
              A known total, gathered in an account and paid out by a finish date. What to put
              in, and when, is worked out from what&rsquo;s left.
            </DialogDescription>
          </DialogHeader>
          {oneOff && <input type="hidden" name="id" value={oneOff.id} />}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="oo-name">What for</FieldLabel>
              <Input
                id="oo-name"
                name="name"
                required
                defaultValue={oneOff?.name}
                placeholder="Flights to Fiji"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="oo-total">Total</FieldLabel>
                <Input
                  id="oo-total"
                  name="total"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  required
                  defaultValue={oneOff?.total}
                />
              </Field>
              <Field>
                <FieldLabel>Tracking account</FieldLabel>
                <Select
                  name="accountId"
                  items={accountItems}
                  defaultValue={oneOff ? String(oneOff.accountId) : accountItems[0]?.value}
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
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="oo-start">Start</FieldLabel>
                <Input
                  id="oo-start"
                  name="startDate"
                  type="date"
                  required
                  defaultValue={oneOff?.startDate ?? today}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="oo-finish">Finish</FieldLabel>
                <Input
                  id="oo-finish"
                  name="finishDate"
                  type="date"
                  required
                  defaultValue={oneOff?.finishDate}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Paid out</FieldLabel>
              <Select
                name="outMode"
                items={OUT_MODES}
                value={outMode}
                onValueChange={(v) => setOutMode(v as OneOffOutMode)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUT_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {outMode === "spread" && (
                <Field>
                  <FieldLabel>Pay a part</FieldLabel>
                  <FrequencySelect name="outEvery" defaultValue={oneOff?.outEvery ?? "month"} />
                  <FieldDescription>The last part falls on the finish date.</FieldDescription>
                </Field>
              )}
              <Field>
                <FieldLabel>Put money in</FieldLabel>
                <FrequencySelect name="inEvery" defaultValue={oneOff?.inEvery ?? "month"} />
                <FieldDescription>Counted from the start date.</FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="oo-set-aside">Already set aside (optional)</FieldLabel>
              <Input
                id="oo-set-aside"
                name="setAside"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                defaultValue={oneOff?.setAside || ""}
                placeholder="0"
              />
              <FieldDescription>
                Money already in the account for it that isn&rsquo;t a linked transaction.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="oo-note">Note (optional)</FieldLabel>
              <Input id="oo-note" name="note" defaultValue={oneOff?.note ?? ""} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || accountItems.length === 0}>
              {pending ? "Saving…" : oneOff ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
