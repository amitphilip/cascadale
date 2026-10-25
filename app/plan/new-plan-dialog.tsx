"use client"

import { useState } from "react"

import { createPlan } from "@/app/actions"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useServerAction } from "@/hooks/use-server-action"
import { FREQUENCIES, FREQUENCY_LABELS, type Frequency } from "@/lib/plan"

const FREQUENCY_ITEMS = FREQUENCIES.map((value) => ({ value, label: FREQUENCY_LABELS[value] }))

export function NewPlanDialog({ trigger }: { trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false)
  const [frequency, setFrequency] = useState<Frequency>("payday")
  const { pending, execute } = useServerAction()

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form
          action={(form) =>
            execute(() => createPlan(String(form.get("goals") ?? ""), frequency), {
              success: "Plan ready",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
            <DialogDescription>
              Claude splits each payday into pots so every bill is covered when it’s due.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Move money into pots</FieldLabel>
              <Select
                items={FREQUENCY_ITEMS}
                value={frequency}
                onValueChange={(v) => setFrequency(v as Frequency)}
                disabled={pending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCY_ITEMS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {frequency === "payday"
                  ? "A transfer each time pay lands."
                  : frequency === "fortnightly"
                    ? "One transfer every two weeks, on payday if you're paid fortnightly."
                    : "One transfer a month, on payday if you're paid monthly, else the 1st."}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="plan-goals">Anything it should know? (optional)</FieldLabel>
              <Textarea
                id="plan-goals"
                name="goals"
                rows={4}
                placeholder="e.g. Save for a holiday in June. Keep bill money in the Joint account."
                disabled={pending}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Planning… this can take a minute" : "Create plan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
