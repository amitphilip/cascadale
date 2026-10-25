"use client"

import { useRef } from "react"

import { removeAkahuTokens, saveAkahuTokens } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import type { AkahuStatus } from "@/lib/akahu"

export function AkahuForm({ status }: { status: AkahuStatus }) {
  const { pending, execute } = useServerAction()
  const formRef = useRef<HTMLFormElement>(null)
  return (
    <form
      ref={formRef}
      action={(form) =>
        execute(() => saveAkahuTokens(form), {
          success: "Akahu tokens saved",
          onSuccess: () => formRef.current?.reset(),
        })
      }
      className="grid max-w-md gap-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="appToken">App ID Token</FieldLabel>
          <Input
            id="appToken"
            name="appToken"
            type="password"
            autoComplete="off"
            placeholder={status ? "••••••••" : "app_token_…"}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="userToken">User Access Token</FieldLabel>
          <Input
            id="userToken"
            name="userToken"
            type="password"
            autoComplete="off"
            placeholder={status ? `•••• ${status.hint}` : "user_token_…"}
          />
          <FieldDescription>
            {status?.source === "settings"
              ? "Tokens are saved. Enter both again to replace them."
              : status?.source === "env"
                ? "Using AKAHU_APP_TOKEN and AKAHU_USER_TOKEN from the environment. Tokens saved here take precedence."
                : "Create a personal app at my.akahu.nz → Developers, then paste both tokens here."}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="w-fit">
          Save tokens
        </Button>
        {status?.source === "settings" && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => execute(() => removeAkahuTokens(), { success: "Akahu disconnected" })}
          >
            Disconnect
          </Button>
        )}
      </div>
    </form>
  )
}
