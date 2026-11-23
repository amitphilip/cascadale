import Link from "next/link"
import {
  ArrowRightIcon,
  BankIcon,
  CalendarCheckIcon,
  SparkleIcon,
  TagIcon,
  WarningIcon,
} from "@phosphor-icons/react/ssr"

import { AkahuSyncButton } from "@/components/akahu-sync-button"
import { Card, CardContent } from "@/components/ui/card"
import { STALE_SYNC_HOURS } from "@/lib/health"
import type { BudgetInputs } from "@/lib/queries"
import { cn } from "@/lib/utils"

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function ago(iso: string, now: Date) {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${plural(minutes, "minute")} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${plural(hours, "hour")} ago`
  return `${plural(Math.round(hours / 24), "day")} ago`
}

/**
 * The top of the Budgets tab: what the budget is built from. The bank feed sync, and
 * the setup pages that shape it, each with how it stands and a way to fix it.
 */
export function BudgetInputsStrip({
  inputs,
  akahuConnected,
}: {
  inputs: BudgetInputs
  akahuConnected: boolean
}) {
  const now = new Date()
  const { accounts, linked, uncategorized, rules, oneOffs, lastSyncedAt, failing } = inputs
  const stale =
    linked > 0 &&
    (lastSyncedAt === null ||
      now.getTime() - new Date(lastSyncedAt).getTime() > STALE_SYNC_HOURS * 3_600_000)

  const sync = !akahuConnected
    ? { text: "Bank feeds aren't connected", detail: "Add your Akahu tokens in Settings", warn: true }
    : linked === 0
      ? { text: "No accounts linked to a bank feed", detail: "Link them on Import & sync", warn: true }
      : failing > 0
        ? {
            text: `${plural(failing, "account")} didn't sync`,
            detail: "See the error under each on Import & sync",
            warn: true,
          }
        : {
            text: lastSyncedAt ? `Synced ${ago(lastSyncedAt, now)}` : "Not synced yet",
            detail: `${plural(linked, "account")} on bank feeds · syncs hourly`,
            warn: stale,
          }

  const links = [
    {
      href: "/review",
      icon: SparkleIcon,
      label: "Review categories",
      detail: uncategorized ? `${uncategorized} uncategorized` : "All categorized",
      warn: uncategorized > 0,
    },
    {
      href: "/categories",
      icon: TagIcon,
      label: "Categories & rules",
      detail: plural(rules, "rule"),
      warn: false,
    },
    {
      href: "/accounts",
      icon: BankIcon,
      label: "Accounts",
      detail: plural(accounts, "account"),
      warn: false,
    },
    {
      href: "/one-offs",
      icon: CalendarCheckIcon,
      label: "One-off payments",
      detail: oneOffs ? `${oneOffs} planned` : "None planned",
      warn: false,
    },
  ]

  return (
    <Card size="sm" className="max-sm:[--card-spacing:--spacing(4)]">
      <CardContent className="grid gap-3 lg:grid-cols-[minmax(16rem,auto)_1fr] lg:items-center lg:gap-6">
        <div className="flex items-center justify-between gap-3 lg:border-r lg:pr-6">
          <div className="min-w-0">
            <div className={cn("flex items-center gap-1.5 font-medium", sync.warn && "text-destructive")}>
              {sync.warn && <WarningIcon className="size-4 shrink-0" />}
              <span className="truncate">{sync.text}</span>
            </div>
            <Link
              href={!akahuConnected ? "/settings" : "/import"}
              className="block truncate text-xs text-muted-foreground hover:underline hover:underline-offset-4"
            >
              {sync.detail}
            </Link>
          </div>
          {akahuConnected && linked > 0 && <AkahuSyncButton />}
        </div>
        <nav aria-label="Budget setup" className="grid grid-cols-2 gap-1 sm:grid-cols-4">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="group flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent active:bg-accent"
            >
              <l.icon className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{l.label}</span>
                <span
                  className={cn(
                    "block truncate text-xs",
                    l.warn ? "font-medium text-destructive" : "text-muted-foreground"
                  )}
                >
                  {l.detail}
                </span>
              </span>
              <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 max-sm:hidden" />
            </Link>
          ))}
        </nav>
      </CardContent>
    </Card>
  )
}
