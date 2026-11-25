"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import { refreshShortTermAction } from "./short-term-actions"

/**
 * Shown while the short-term allocation is out of date (a sync brought in a pay or a move
 * since Cas last looked): Cas looks again once, then the card shows what it decided.
 */
export function ShortTermRefresh() {
  const router = useRouter()
  const started = useRef(false)
  const [state, setState] = useState<"looking" | "done" | "failed">("looking")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (started.current) return
    started.current = true
    refreshShortTermAction().then((r) => {
      if (r.ok) {
        setState("done")
        if (r.looked) router.refresh()
      } else {
        setState("failed")
        setError(r.error)
      }
    })
  }, [router])

  if (state === "done") return null
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {state === "looking" ? (
        <span className="animate-pulse">Cas is going over this pay&rsquo;s moves&hellip;</span>
      ) : (
        <>Cas couldn&rsquo;t go over this pay&rsquo;s moves{error ? `: ${error}` : ""}.</>
      )}
    </p>
  )
}
