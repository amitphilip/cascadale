"use client"

import { saveMyPrefs } from "@/app/actions"
import { Button } from "@/components/ui/button"
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
import type { HomeView } from "@/lib/views"

const VIEW_ITEMS = [
  { value: "me", label: "My own money" },
  { value: "family", label: "The family’s" },
]

/** Your name and the view the app opens on for you. */
export function YouForm({ name, homeView }: { name: string; homeView: HomeView }) {
  const { pending, execute } = useServerAction()
  return (
    <form
      action={(form) =>
        execute(
          () =>
            saveMyPrefs({
              name: String(form.get("name") ?? ""),
              homeView: String(form.get("homeView") ?? "family"),
            }),
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
        <Field>
          <FieldLabel htmlFor="homeView">Open the app on</FieldLabel>
          <Select name="homeView" items={VIEW_ITEMS} defaultValue={homeView}>
            <SelectTrigger id="homeView" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VIEW_ITEMS.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            The other views, and the accountant’s, are a tap away on the Plan page.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending} className="w-fit">
        Save
      </Button>
    </form>
  )
}
