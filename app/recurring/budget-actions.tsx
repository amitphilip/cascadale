"use client"

import { setCategoryBudgets } from "@/app/actions"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

type Budget = { categoryId: number; amount: number }

/** Sets one category's monthly budget to its projection. */
export function UseAsBudgetButton({ budget, label }: { budget: Budget; label: string }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => execute(() => setCategoryBudgets([budget]), { success: `${label} budget set` })}
    >
      Use
    </Button>
  )
}

/** Sets every expense category's monthly budget to its projection. */
export function ApplyAllBudgetsButton({ budgets }: { budgets: Budget[] }) {
  const { pending, execute } = useServerAction()
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={pending || budgets.length === 0}>
          Set all budgets
        </Button>
      }
      title="Set budgets from projections?"
      description={`This replaces the monthly budget on ${budgets.length} expense categories with their projected amount, rounded to the nearest whole unit. Categories projected at zero have their budget cleared.`}
      confirmLabel="Set budgets"
      destructive={false}
      onConfirm={() =>
        execute(() => setCategoryBudgets(budgets), {
          success: (r) => `Updated ${r.count} budgets`,
        })
      }
    />
  )
}
