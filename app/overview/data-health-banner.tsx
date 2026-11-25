import Link from "next/link"
import { WarningIcon } from "@phosphor-icons/react/ssr"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { loadDataHealth } from "@/lib/data-health"
import { formatMoney, type MoneyFormat } from "@/lib/format"

/**
 * Shown only when the numbers can't be trusted: a bank feed gone stale, or a balance off from
 * the bank. Drift that pending payments explain, or that's small while they settle, isn't shown:
 * it closes once they post.
 */
export async function DataHealthBanner({ fmt }: { fmt: MoneyFormat }) {
  const health = await loadDataHealth().catch((err: unknown) => {
    console.error(err)
    return null
  })
  if (!health) return null
  const stale = health.accounts.filter((a) => a.stale)
  const drifted = health.drift.filter((d) => !d.explainedByPending && !d.settling)
  if (stale.length === 0 && drifted.length === 0) return null

  const lines = [
    ...stale.map((a) => `${a.name}: ${a.staleReason}.`),
    ...drifted.map((d) => {
      const gap = d.gap ?? d.difference ?? 0
      const bank = d.institution ?? "the bank"
      const pending = d.pendingCount
        ? `, counting ${d.pendingCount} pending ${d.pendingCount === 1 ? "payment" : "payments"}`
        : ""
      return `${d.account} is ${formatMoney(Math.abs(gap), fmt)} ${gap < 0 ? "under" : "over"} ${bank}${pending}.`
    }),
  ]
  // One drifted account and nothing stale: go straight to its transactions to find the gap
  const href = stale.length
    ? "/import"
    : drifted.length === 1
      ? `/transactions?account=${drifted[0].accountId}`
      : "/transactions"

  return (
    <Alert variant="warning">
      <WarningIcon weight="fill" />
      <AlertTitle>
        {stale.length > 0
          ? "Some numbers may be out of date"
          : drifted.length === 1
            ? "A balance is off from the bank"
            : "Some balances are off from the bank"}
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
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={href} />}>
          {stale.length ? "Check feeds" : "See transactions"}
        </Button>
      </AlertAction>
    </Alert>
  )
}
