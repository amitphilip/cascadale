"use client"

import { deleteAsset } from "@/app/actions"
import { AssetDialog } from "@/components/asset-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"
import type { Asset } from "@/lib/db/schema"

export function AssetActions({ asset, today }: { asset: Asset; today: string }) {
  const { execute } = useServerAction()

  return (
    <div className="flex justify-end gap-1">
      <AssetDialog
        asset={asset}
        today={today}
        trigger={<Button variant="ghost" size="sm">Edit</Button>}
      />
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive">
            Delete
          </Button>
        }
        title={`Delete “${asset.name}”?`}
        description="This removes the asset and its value from your net worth."
        onConfirm={() => execute(() => deleteAsset(asset.id), { success: "Asset deleted" })}
      />
    </div>
  )
}
