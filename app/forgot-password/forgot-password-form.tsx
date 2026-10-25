"use client"

import Link from "next/link"
import { useState } from "react"

import { requestPasswordReset } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"

export function ForgotPasswordForm() {
  const { pending, execute } = useServerAction()
  const [sentTo, setSentTo] = useState<string | null>(null)

  if (sentTo) {
    return (
      <div className="grid gap-6 text-sm">
        <p>
          If <span className="font-medium">{sentTo}</span> has an account, a
          reset link is on its way. It works once and expires in an hour.
        </p>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/sign-in" />}
        >
          Back to sign in
        </Button>
      </div>
    )
  }

  return (
    <form
      action={(form) =>
        execute(() => requestPasswordReset(form), {
          onSuccess: () => setSentTo(String(form.get("email")).trim()),
        })
      }
      className="grid gap-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
          />
        </Field>
      </FieldGroup>
      <div className="grid gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send reset link"}
        </Button>
        <Button
          variant="ghost"
          nativeButton={false}
          render={<Link href="/sign-in" />}
        >
          Back to sign in
        </Button>
      </div>
    </form>
  )
}
