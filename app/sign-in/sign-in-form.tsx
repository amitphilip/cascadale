"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"

import { signIn } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"

export function SignInForm({ next }: { next: string }) {
  const router = useRouter()
  const { pending, execute } = useServerAction()
  return (
    <form
      action={(form) =>
        execute(() => signIn(form), {
          onSuccess: () => {
            router.replace(next)
            router.refresh()
          },
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
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Link
              href="/forgot-password"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
