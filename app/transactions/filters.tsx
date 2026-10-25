"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react"

import type { CategoryOption } from "@/components/category-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { CATEGORY_KIND_LABELS } from "@/lib/format"

const ALL = "all"

export function TransactionFilters({
  accounts,
  categories,
  months,
  monthLabels,
}: {
  accounts: { id: number; name: string }[]
  categories: CategoryOption[]
  months: string[]
  monthLabels: Record<string, string>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [q, setQ] = useState(params.get("q") ?? "")

  function update(key: string, value: string | null) {
    const next = new URLSearchParams(params)
    if (value === null || value === "" || value === ALL) next.delete(key)
    else next.set(key, value)
    next.delete("page")
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  // Debounced search
  useEffect(() => {
    if (q === (params.get("q") ?? "")) return
    const t = setTimeout(() => update("q", q.trim()), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const accountItems = [
    { value: ALL, label: "All accounts" },
    ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
  ]
  const monthItems = [
    { value: ALL, label: "All time" },
    ...months.map((m) => ({ value: m, label: monthLabels[m] ?? m })),
  ]
  const category = params.get("category")
  const hasFilters = ["account", "category", "month", "q"].some((k) => params.get(k))

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative w-full sm:w-64">
        <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search descriptions"
          className="pl-8"
          aria-label="Search descriptions"
        />
      </div>
      <Select
        items={accountItems}
        value={params.get("account") ?? ALL}
        onValueChange={(v) => update("account", v as string)}
      >
        <SelectTrigger aria-label="Account" className="w-full sm:w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {accountItems.map((a) => (
            <SelectItem key={a.value} value={a.value}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CategoryFilter
        categories={categories}
        value={category}
        onChange={(v) => update("category", v)}
      />
      <Select
        items={monthItems}
        value={params.get("month") ?? ALL}
        onValueChange={(v) => update("month", v as string)}
      >
        <SelectTrigger aria-label="Month" className="w-full sm:w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="max-h-80">
          {monthItems.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasFilters && (
        <Button
          variant="ghost"
          onClick={() => {
            setQ("")
            router.replace(pathname, { scroll: false })
          }}
        >
          <XIcon data-icon="inline-start" />
          Clear
        </Button>
      )}
    </div>
  )
}

/** "All categories" / "Uncategorized" / a specific category. */
function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: CategoryOption[]
  value: string | null
  onChange: (v: string | null) => void
}) {
  const items = [
    { value: ALL, label: "All categories" },
    { value: "none", label: "Uncategorized" },
    ...categories.map((c) => ({ value: String(c.id), label: c.name })),
  ]
  const kinds = ["expense", "income", "transfer"] as const
  return (
    <Select items={items} value={value ?? ALL} onValueChange={(v) => onChange(v as string)}>
      <SelectTrigger aria-label="Category" className="w-full sm:w-fit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="max-h-80">
        <SelectItem value={ALL}>All categories</SelectItem>
        <SelectItem value="none">Uncategorized</SelectItem>
        {kinds.map((kind) => (
          <SelectGroup key={kind}>
            <SelectSeparator />
            <SelectLabel>{CATEGORY_KIND_LABELS[kind]}</SelectLabel>
            {categories
              .filter((c) => c.kind === kind)
              .map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
