"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

/** Switches the statement between actuals alongside averages and averages only. */
export function ViewToggle({ avgOnly }: { avgOnly: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function change(v: string) {
    const next = new URLSearchParams(params)
    if (v === "avg") next.set("view", "avg")
    else next.delete("view")
    router.replace(`${pathname}?${next}`, { scroll: false })
  }

  return (
    <Tabs value={avgOnly ? "avg" : "all"} onValueChange={change} className="w-full sm:w-auto">
      <TabsList aria-label="Columns to show" className="w-full sm:w-fit">
        <TabsTrigger value="all">Actuals</TabsTrigger>
        <TabsTrigger value="avg">Averages</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
