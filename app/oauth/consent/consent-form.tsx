"use client"

import { decideAuthorization } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

export function ConsentForm({ authorizationId }: { authorizationId: string }) {
  const { pending, execute } = useServerAction()
  const decide = (approve: boolean) =>
    execute(() => decideAuthorization(authorizationId, approve), {
      onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl),
    })
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button variant="outline" disabled={pending} onClick={() => decide(false)}>
        Deny
      </Button>
      <Button disabled={pending} onClick={() => decide(true)}>
        {pending ? "Connecting…" : "Allow"}
      </Button>
    </div>
  )
}
