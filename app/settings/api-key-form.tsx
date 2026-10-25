"use client"

import { useRef } from "react"

import { removeApiKey, saveApiKey } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import type { ApiKeyStatus } from "@/lib/anthropic"

export function ApiKeyForm({ status }: { status: ApiKeyStatus }) {
  const { pending, execute } = useServerAction()
  const formRef = useRef<HTMLFormElement>(null)
  return (
    <form
      ref={formRef}
      action={(form) =>
        execute(() => saveApiKey(form), {
          success: "API key saved",
          onSuccess: () => formRef.current?.reset(),
        })
      }
      className="grid max-w-md gap-6"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="apiKey">Anthropic API key</FieldLabel>
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={status ? `•••• ${status.hint}` : "sk-ant-…"}
          />
          <FieldDescription>
            {status?.source === "settings"
              ? "A key is saved. Enter a new one to replace it."
              : status?.source === "env"
                ? "Using ANTHROPIC_API_KEY from the environment. A key saved here takes precedence."
                : "Needed for auto-categorization and the planner. Get one at console.anthropic.com."}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="w-fit">
          Save key
        </Button>
        {status?.source === "settings" && (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => execute(() => removeApiKey(), { success: "API key removed" })}
          >
            Remove
          </Button>
        )}
      </div>
    </form>
  )
}
