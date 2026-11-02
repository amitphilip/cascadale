"use client"

import { TrashIcon } from "@phosphor-icons/react"

import { removePlanAdjustment, removePlanPot } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

export function RemovePotButton({ name }: { name: string }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Remove pot ${name}`}
      disabled={pending}
      onClick={() => execute(() => removePlanPot(name), { success: `Removed ${name}` })}
    >
      <TrashIcon />
    </Button>
  )
}

export function RemoveAdjustmentButton({ id, label }: { id: number; label: string }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Remove ${label}`}
      disabled={pending}
      onClick={() => execute(() => removePlanAdjustment(id), { success: "Adjustment removed" })}
    >
      <TrashIcon />
    </Button>
  )
}
