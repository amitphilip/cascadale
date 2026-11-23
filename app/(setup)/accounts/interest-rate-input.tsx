"use client"

import { useState } from "react"

import { setAccountInterestRate } from "@/app/actions"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import { cn } from "@/lib/utils"

/** An account's annual interest rate in percent, saved when you leave the box. Blank clears it. */
export function InterestRateInput({
  account,
  rate,
  className,
}: {
  account: { id: number; name: string }
  rate: number | null
  className?: string
}) {
  const saved = rate === null ? "" : String(rate)
  const [value, setValue] = useState(saved)
  const { pending, execute } = useServerAction()

  function save() {
    const text = value.trim().replace(/%$/, "").trim()
    if (text === saved) return
    const next = text === "" ? null : Number(text)
    if (next !== null && !Number.isFinite(next)) {
      setValue(saved)
      return
    }
    execute(() => setAccountInterestRate(account.id, next), {
      success: next === null ? `${account.name}: rate cleared` : `${account.name}: ${next}% a year`,
      onError: () => setValue(saved),
    })
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        inputMode="decimal"
        placeholder="—"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
          if (e.key === "Escape") {
            setValue(saved)
            e.currentTarget.blur()
          }
        }}
        aria-label={`Interest rate for ${account.name}, % a year`}
        className="pr-7 text-right tabular-nums max-sm:h-10"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-sm text-muted-foreground">
        %
      </span>
    </div>
  )
}
