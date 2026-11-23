"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Debounced search over merchant names, descriptions and notes (?q=). */
export function MerchantSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [q, setQ] = useState(params.get("q") ?? "")

  useEffect(() => {
    if (q.trim() === (params.get("q") ?? "")) return
    const t = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (q.trim()) next.set("q", q.trim())
      else next.delete("q")
      router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  return (
    <div className="relative w-full sm:w-72">
      <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search merchants or notes"
        aria-label="Search merchants"
        className="px-8"
      />
      {q && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 -translate-y-1/2"
          onClick={() => setQ("")}
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}
