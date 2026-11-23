"use client"

import { saveSettings } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import type { MoneyFormat } from "@/lib/format"

export function SettingsForm({ current }: { current: MoneyFormat }) {
  const { pending, execute } = useServerAction()
  return (
    <form
      action={(form) => execute(() => saveSettings(form), { success: "Settings saved" })}
      className="grid max-w-md gap-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="currency">Currency</FieldLabel>
          <Input
            id="currency"
            name="currency"
            defaultValue={current.currency}
            maxLength={3}
            className="w-28 uppercase"
          />
          <FieldDescription>ISO code such as USD, EUR, GBP or INR. Used for display.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="locale">Locale</FieldLabel>
          <Input id="locale" name="locale" defaultValue={current.locale} className="w-40" />
          <FieldDescription>Controls number and date formatting, e.g. en-US, en-GB, en-IN.</FieldDescription>
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending} className="w-fit">
        Save
      </Button>
    </form>
  )
}
