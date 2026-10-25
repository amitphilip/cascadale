"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function MonthPicker({
  months,
  value,
}: {
  months: { value: string; label: string }[]
  value: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function change(v: string) {
    const next = new URLSearchParams(params)
    next.set("month", v)
    router.push(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <Select
      items={months}
      value={value}
      onValueChange={(v) => change(v as string)}
    >
      <SelectTrigger aria-label="Month" className="w-full min-w-0 sm:w-auto sm:min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="max-h-80">
        {months.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
