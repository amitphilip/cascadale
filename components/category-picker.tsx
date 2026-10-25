"use client"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Category } from "@/lib/db/schema"
import { CATEGORY_KIND_LABELS } from "@/lib/format"

export type CategoryOption = Pick<Category, "id" | "name" | "kind">

const NONE = "none"

/** Category select grouped by kind. Value is a category id or null. */
export function CategoryPicker({
  categories,
  value,
  defaultValue,
  onValueChange,
  name,
  size = "default",
  className,
  placeholder = "Uncategorized",
  disabled,
}: {
  categories: CategoryOption[]
  value?: number | null
  defaultValue?: number | null
  onValueChange?: (id: number | null) => void
  name?: string
  size?: "sm" | "default"
  className?: string
  placeholder?: string
  disabled?: boolean
}) {
  const items = [
    { value: NONE, label: placeholder },
    ...categories.map((c) => ({ value: String(c.id), label: c.name })),
  ]
  const toStr = (v: number | null | undefined) => (v == null ? NONE : String(v))
  const kinds = ["expense", "income", "transfer"] as const

  return (
    <Select
      name={name}
      items={items}
      disabled={disabled}
      {...(value !== undefined ? { value: toStr(value) } : { defaultValue: toStr(defaultValue) })}
      onValueChange={(v) => onValueChange?.(v === NONE || v == null ? null : Number(v))}
    >
      <SelectTrigger size={size} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="max-h-80">
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{placeholder}</span>
        </SelectItem>
        {kinds.map((kind) => {
          const group = categories.filter((c) => c.kind === kind)
          if (group.length === 0) return null
          return (
            <SelectGroup key={kind}>
              <SelectSeparator />
              <SelectLabel>{CATEGORY_KIND_LABELS[kind]}</SelectLabel>
              {group.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
      </SelectContent>
    </Select>
  )
}
