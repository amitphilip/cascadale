"use client"

import { useState } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** A read-only value with a button that copies it, e.g. a connector URL to paste elsewhere. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Couldn't copy. Select the address and copy it yourself.")
    }
  }

  return (
    <div className="flex min-w-0 gap-2">
      <Input
        readOnly
        value={value}
        aria-label={label}
        className="min-w-0 font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button type="button" variant="outline" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}
