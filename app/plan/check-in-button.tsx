"use client"

import { SparkleIcon } from "@phosphor-icons/react"

import { checkIn } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

/** Compare what's happened since the last check-in with the plan, as the Overview's Log does. */
export function CheckInButton({ size = "sm" }: { size?: "sm" | "default" }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      size={size}
      variant="outline"
      disabled={pending}
      onClick={() => execute(() => checkIn(), { success: "Check-in ready" })}
    >
      <SparkleIcon className={pending ? "animate-pulse" : undefined} />
      {pending ? "Checking in…" : "Check in"}
    </Button>
  )
}
