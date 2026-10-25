"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { RANGES, type Range } from "./ranges"

/** Months of history the income page looks back over. */
export function RangePicker({ value }: { value: Range }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function change(v: Range) {
    const next = new URLSearchParams(params)
    if (v === "2y") next.delete("range")
    else next.set("range", v)
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <Tabs value={value} onValueChange={(v) => change(v as Range)} className="w-full sm:w-auto">
      <TabsList aria-label="History to show" className="w-full sm:w-fit">
        {(Object.keys(RANGES) as Range[]).map((r) => (
          <TabsTrigger key={r} value={r} className="px-1.5 text-xs sm:px-2 sm:text-sm">
            {RANGES[r]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
