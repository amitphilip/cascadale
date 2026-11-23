import Link from "next/link"
import { WarningIcon } from "@phosphor-icons/react/ssr"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { loadDataHealth } from "@/lib/data-health"

/** Shown only when the numbers can't be trusted: a bank feed gone stale, or a balance off from the bank. */
export async function DataHealthBanner() {
  const health = await loadDataHealth().catch((err: unknown) => {
    console.error(err)
    return null
  })
  if (!health) return null
  const stale = health.accounts.filter((a) => a.stale)
  const drifted = health.drift.filter((d) => !d.explainedByPending)
  if (stale.length === 0 && drifted.length === 0) return null

  const lines = [
    ...stale.map((a) => `${a.name}: ${a.staleReason}.`),
    ...drifted.map((d) => `${d.account} doesn't match the bank.`),
  ]
  return (
    <Alert variant="warning">
      <WarningIcon weight="fill" />
      <AlertTitle>
        {stale.length > 0 ? "Some numbers may be out of date" : "A balance doesn't match the bank"}
      </AlertTitle>
      <AlertDescription>
        <ul className="grid gap-0.5">
          {lines.slice(0, 3).map((l) => (
            <li key={l}>{l}</li>
          ))}
          {lines.length > 3 && <li>And {lines.length - 3} more.</li>}
        </ul>
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={stale.length ? "/import" : "/accounts"} />}>
          Fix
        </Button>
      </AlertAction>
    </Alert>
  )
}
