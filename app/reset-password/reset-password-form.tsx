"use client"

import { useRouter } from "next/navigation"

import { updatePassword } from "@/app/actions"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"

export function ResetPasswordForm() {
  const router = useRouter()
  const { pending, execute } = useServerAction()
  return (
    <form
      action={(form) =>
        execute(() => updatePassword(form), {
          success: "Password updated",
          onSuccess: () => router.replace("/"),
        })
      }
      className="grid gap-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            autoFocus
          />
          <FieldDescription>At least 8 characters.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? "Saving…" : "Save password"}
      </Button>
    </form>
  )
}
