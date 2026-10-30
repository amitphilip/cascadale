import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon } from "@phosphor-icons/react/ssr"

import { AssetActions } from "./asset-actions"
import { AssetDialog } from "@/components/asset-dialog"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ACCOUNT_TYPE_LABELS, ASSET_KIND_LABELS, formatDate, formatMoney } from "@/lib/format"
import { buildNetWorth, type NetWorthAccount } from "@/lib/net-worth"
import { getAccountsWithBalances, getAssets, getSettings } from "@/lib/queries"
import { localDate } from "@/supabase/functions/_shared/akahu"

export const metadata: Metadata = { title: "Net worth" }

export default async function NetWorthPage() {
  const [accounts, assets, fmt] = await Promise.all([
    getAccountsWithBalances(),
    getAssets(),
    getSettings(),
  ])
  const worth = buildNetWorth(accounts, assets)
  const money = (n: number) => formatMoney(n, fmt)
  const today = localDate(new Date().toISOString())

  const summary = [
    { label: "Net worth", value: worth.netWorth },
    { label: "What you own", value: worth.owned },
    { label: "What you owe", value: worth.totals.debts },
  ]

  const accountCard = (title: string, rows: NetWorthAccount[], sum: number) =>
    rows.length > 0 && (
      <Card>
        <CardHeader>
          <CardTitle className="flex justify-between gap-3">
            <span>{title}</span>
            <span className="tabular-nums">{money(sum)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {rows.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/transactions?account=${a.id}`} className="font-medium hover:underline">
                  {a.name}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {ACCOUNT_TYPE_LABELS[a.type]}
                  {a.institution ? ` · ${a.institution}` : ""}
                </div>
              </div>
              <span className="tabular-nums">{money(a.balance)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    )

  return (
    <>
      <PageHeader
        title="Net worth"
        description="Your account balances plus the assets you value here."
      >
        <AssetDialog
          today={today}
          trigger={
            <Button>
              <PlusIcon data-icon="inline-start" />
              Add asset
            </Button>
          }
        />
      </PageHeader>

      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {summary.map((s) => (
            <Card key={s.label} size="sm">
              <CardContent>
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="text-2xl font-semibold tabular-nums">{money(s.value)}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex justify-between gap-3">
              <span>Assets</span>
              <span className="tabular-nums">{money(worth.totals.assets)}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {worth.assets.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No assets yet. Add your house so the loans against it are balanced by its value.
              </p>
            )}
            {worth.assets.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {ASSET_KIND_LABELS[a.kind]} · valued {formatDate(a.valuedOn, fmt.locale)}
                    {a.note ? ` · ${a.note}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">{money(a.value)}</span>
                  <AssetActions asset={a} today={today} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {accountCard("Investments", worth.investments, worth.totals.investments)}
        {accountCard("Cash", worth.cash, worth.totals.cash)}
        {accountCard("Debts", worth.debts, worth.totals.debts)}
      </div>
    </>
  )
}
