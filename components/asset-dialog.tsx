"use client"

import { useState } from "react"

import { saveAsset } from "@/app/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useServerAction } from "@/hooks/use-server-action"
import { ASSET_KINDS, type Asset } from "@/lib/db/schema"
import { ASSET_KIND_LABELS } from "@/lib/format"

const kindItems = ASSET_KINDS.map((k) => ({ value: k, label: ASSET_KIND_LABELS[k] }))

export function AssetDialog({
  asset,
  today,
  trigger,
}: {
  asset?: Pick<Asset, "id" | "name" | "kind" | "value" | "valuedOn" | "note">
  today: string
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <form
          // Remount when the record changes so default values stay in sync.
          key={JSON.stringify(asset ?? null)}
          action={(form) =>
            execute(() => saveAsset(form), {
              success: asset ? "Asset updated" : "Asset added",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>{asset ? "Edit asset" : "Add asset"}</DialogTitle>
            <DialogDescription>
              Things you own that no bank feed values, such as a house or a car.
            </DialogDescription>
          </DialogHeader>
          {asset && <input type="hidden" name="id" value={asset.id} />}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="asset-name">Name</FieldLabel>
              <Input
                id="asset-name"
                name="name"
                required
                defaultValue={asset?.name}
                placeholder="Family home"
              />
            </Field>
            <Field>
              <FieldLabel>Kind</FieldLabel>
              <Select name="kind" items={kindItems} defaultValue={asset?.kind ?? "property"}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kindItems.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="asset-value">Value</FieldLabel>
                <Input
                  id="asset-value"
                  name="value"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  defaultValue={asset?.value}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="asset-date">Valued on</FieldLabel>
                <Input
                  id="asset-date"
                  name="valuedOn"
                  type="date"
                  required
                  defaultValue={asset?.valuedOn ?? today}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="asset-note">Note</FieldLabel>
              <Input
                id="asset-note"
                name="note"
                defaultValue={asset?.note ?? ""}
                placeholder="Optional, e.g. where the value came from"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {asset ? "Save changes" : "Add asset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
