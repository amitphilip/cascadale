"use client"

import { ArrowsClockwiseIcon, TrashIcon } from "@phosphor-icons/react"

import { rebuildPlan, removePlanAdjustment, removePlanPot } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

/** Rebuild the plan with every pot and adjustment, as regenerate_plan does over MCP. */
export function RebuildButton({ planId, size = "sm" }: { planId: number | null; size?: "sm" | "default" }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      size={size}
      variant="outline"
      disabled={pending}
      onClick={() => execute(() => rebuildPlan(planId), { success: "Plan rebuilt" })}
    >
      <ArrowsClockwiseIcon className={pending ? "animate-spin" : undefined} />
      {pending ? "Rebuilding…" : "Rebuild plan"}
    </Button>
  )
}

export function RemovePotButton({ name }: { name: string }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Remove pot ${name}`}
      disabled={pending}
      onClick={() => execute(() => removePlanPot(name), { success: `Removed ${name}; rebuild to apply` })}
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
      onClick={() => execute(() => removePlanAdjustment(id), { success: "Adjustment removed; rebuild to apply" })}
    >
      <TrashIcon />
    </Button>
  )
}
