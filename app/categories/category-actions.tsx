"use client"

import { deleteCategory } from "@/app/actions"
import { CategoryDialog } from "@/components/category-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"
import type { Category } from "@/lib/db/schema"

export function CategoryActions({
  category,
  txCount,
}: {
  category: Pick<Category, "id" | "name" | "kind" | "monthlyBudget">
  txCount: number
}) {
  const { execute } = useServerAction()
  return (
    <div className="flex justify-end gap-1">
      <CategoryDialog category={category} trigger={<Button variant="ghost" size="sm">Edit</Button>} />
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive">
            Delete
          </Button>
        }
        title={`Delete “${category.name}”?`}
        description={
          txCount > 0
            ? `${txCount} transactions will become uncategorized, and rules pointing here will be removed.`
            : "Rules pointing to this category will be removed."
        }
        onConfirm={() => execute(() => deleteCategory(category.id), { success: "Category deleted" })}
      />
    </div>
  )
}
