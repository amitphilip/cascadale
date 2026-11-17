"use client"

import { saveMyPrefs } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"

/** Your name. */
export function YouForm({ name }: { name: string }) {
  const { pending, execute } = useServerAction()
  return (
    <form
      action={(form) =>
        execute(
          () =>
            saveMyPrefs({ name: String(form.get("name") ?? "") }),
          { success: "Saved" }
        )
      }
      className="grid max-w-md gap-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Your name</FieldLabel>
          <Input id="name" name="name" defaultValue={name} maxLength={40} className="w-56" />
          <FieldDescription>Shown on your view and to Cas.</FieldDescription>
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending} className="w-fit">
        Save
      </Button>
    </form>
  )
}
