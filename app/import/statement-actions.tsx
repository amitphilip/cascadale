"use client"

import { deleteStatement } from "@/app/actions"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

export function DeleteStatementButton({ id, fileName }: { id: number; fileName: string }) {
  const { pending, execute } = useServerAction()
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" className="text-destructive" disabled={pending}>
          Undo import
        </Button>
      }
      title={`Undo import of “${fileName}”?`}
      description="Deletes the transactions this import added (including any edits you made to them) and the stored file."
      confirmLabel="Undo import"
      onConfirm={() => execute(() => deleteStatement(id), { success: "Import removed" })}
    />
  )
}
