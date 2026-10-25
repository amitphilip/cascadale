"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BASIS_LABELS, type DefaultBasis } from "@/lib/recurring"

const BASES: DefaultBasis[] = ["latest", "average", "growth"]

/** Chooses how recurring items are projected unless an item overrides it. */
export function BasisPicker({ value }: { value: DefaultBasis }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function change(v: DefaultBasis) {
    const next = new URLSearchParams(params)
    if (v === "latest") next.delete("basis")
    else next.set("basis", v)
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <Tabs value={value} onValueChange={(v) => change(v as DefaultBasis)} className="w-full sm:w-auto">
      <TabsList aria-label="Project recurring items from" className="w-full sm:w-fit">
        {BASES.map((b) => (
          <TabsTrigger key={b} value={b} className="px-2 text-xs sm:text-sm">
            {BASIS_LABELS[b]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
