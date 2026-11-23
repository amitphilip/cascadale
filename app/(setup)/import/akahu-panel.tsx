"use client"

import Link from "next/link"
import { toast } from "sonner"

import { linkAkahuAccount } from "@/app/actions"
import { AkahuSyncButton } from "@/components/akahu-sync-button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useServerAction } from "@/hooks/use-server-action"
import type { AkahuOverview } from "@/lib/akahu"
import { formatMoney, type MoneyFormat } from "@/lib/format"
import { cn } from "@/lib/utils"

// Akahu accounts are New Zealand ones; showing NZ time also keeps server and browser renders equal.
function syncTime(iso: string, fmt: MoneyFormat) {
  return new Intl.DateTimeFormat(fmt.locale, {
    timeZone: "Pacific/Auckland",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))
}

const NONE = "__none"
const NEW = "__new"

export function AkahuPanel({
  overview,
  accounts,
  fmt,
}: {
  overview: AkahuOverview
  accounts: { id: number; name: string }[]
  fmt: MoneyFormat
}) {
  const { pending, execute } = useServerAction()

  if (!overview.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bank feeds</CardTitle>
          <CardDescription>
            Sync New Zealand bank accounts automatically through Akahu instead of exporting
            statements. Add your personal app tokens in{" "}
            <Link href="/settings" className="underline underline-offset-4">
              Settings
            </Link>{" "}
            to get started.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const items = [
    { value: NONE, label: "Don't sync" },
    { value: NEW, label: "New account" },
    ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
  ]

  function link(akahuId: string, value: string) {
    const target = value === NONE ? null : value === NEW ? ("new" as const) : Number(value)
    execute(() => linkAkahuAccount(akahuId, target), {
      success: (r) =>
        target === null
          ? "Account unlinked"
          : r.syncError
            ? "Account linked"
            : `Account linked, ${r.synced} transactions synced`,
      onSuccess: (r) => {
        if (r.syncError) toast.warning("Couldn't sync it yet", { description: r.syncError })
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bank feeds</CardTitle>
        <CardDescription>
          Each sync adds an account for any Akahu account that has none, linking it to one of
          yours with the same name and bank if there is one. Pick an account here to sync into it
          instead, or Don&apos;t sync. Akahu refreshes from your bank once a day and new
          transactions are synced every hour; linking an account that already has transactions
          only syncs newer ones.
        </CardDescription>
        <CardAction>
          <AkahuSyncButton disabled={pending || overview.accounts.length === 0} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {overview.error && <p className="text-sm text-destructive">{overview.error}</p>}
        {!overview.error && overview.accounts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No accounts with transactions are connected in Akahu yet.
          </p>
        )}
        {overview.accounts.map((a) => (
          <div
            key={a.akahuId}
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium">
                <span className="truncate">{a.name}</span>
                {!a.active && <Badge variant="destructive">Reconnect in Akahu</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                {a.institution}
                {a.formattedAccount ? ` · ${a.formattedAccount}` : ""}
                {a.balance !== null ? ` · ${formatMoney(a.balance, fmt)}` : ""}
              </div>
              {a.lastSync && (
                <div
                  className={cn(
                    "text-xs",
                    a.lastSync.error ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {a.lastSync.error
                    ? `Sync failed ${syncTime(a.lastSync.at, fmt)}: ${a.lastSync.error}`
                    : `Synced ${syncTime(a.lastSync.at, fmt)}` +
                      (a.lastSync.inserted ? `, ${a.lastSync.inserted} new` : "")}
                </div>
              )}
            </div>
            <Select
              items={items}
              value={a.linkedTo !== null ? String(a.linkedTo) : a.ignored ? NONE : null}
              onValueChange={(v) => link(a.akahuId, v as string)}
              disabled={pending}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue placeholder="Added on next sync" />
              </SelectTrigger>
              <SelectContent>
                {items.slice(0, 2).map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
                {accounts.length > 0 && <SelectSeparator />}
                {items.slice(2).map((i) => (
                  <SelectItem key={i.value} value={i.value}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
