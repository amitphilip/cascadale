"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PERIOD_LABELS, PERIODS, type Period } from "@/lib/format"

export function PeriodPicker({ value }: { value: Period }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function change(v: Period) {
    const next = new URLSearchParams(params)
    if (v === "month") next.delete("per")
    else next.set("per", v)
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <Tabs value={value} onValueChange={(v) => change(v as Period)} className="w-full sm:w-auto">
      <TabsList aria-label="Show amounts per" className="w-full sm:w-fit">
        {PERIODS.map((p) => (
          <TabsTrigger key={p} value={p} className="px-1.5 text-xs sm:px-2 sm:text-sm">
            {PERIOD_LABELS[p]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
