import type { Metadata } from "next"
import { BankIcon, PlusIcon } from "@phosphor-icons/react/ssr"

import { AccountActions } from "./account-actions"
import { AccountDialog } from "@/components/account-dialog"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ACCOUNT_TYPE_LABELS, formatDate, formatMoney } from "@/lib/format"
import { getAccountsWithBalances, getSettings } from "@/lib/queries"

export const metadata: Metadata = { title: "Accounts" }

export default async function AccountsPage() {
  const [accounts, fmt] = await Promise.all([getAccountsWithBalances(), getSettings()])
  const active = accounts.filter((a) => !a.archived)
  const netWorth = active.reduce((s, a) => s + a.balance, 0)

  const addButton = (
    <Button>
      <PlusIcon data-icon="inline-start" />
      Add account
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Balances are the opening balance plus every recorded transaction."
      >
        <AccountDialog trigger={addButton} />
      </PageHeader>

      {accounts.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BankIcon />
            </EmptyMedia>
            <EmptyTitle>No accounts yet</EmptyTitle>
            <EmptyDescription>
              Add each bank account, card or loan you want to track, then import its statements.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <AccountDialog trigger={addButton} />
          </EmptyContent>
        </Empty>
      ) : (
        <>
        <div className="grid gap-3 md:hidden">
          {accounts.map((a) => (
            <Card key={a.id} size="sm" className={a.archived ? "opacity-60" : undefined}>
              <CardContent className="grid gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {ACCOUNT_TYPE_LABELS[a.type]}
                      {a.institution ? ` · ${a.institution}` : ""}
                    </div>
                  </div>
                  <AccountActions account={a} />
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {a.txCount} transactions
                    {a.lastDate ? ` · ${formatDate(a.lastDate, fmt.locale)}` : ""}
                  </span>
                  <span className="font-medium tabular-nums">{formatMoney(a.balance, fmt)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
          <p className="px-1 text-sm text-muted-foreground">
            Net worth{" "}
            <span className="font-medium text-foreground tabular-nums">{formatMoney(netWorth, fmt)}</span>
          </p>
        </div>
        <Card className="hidden py-0 md:block">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Account</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Transactions</TableHead>
                  <TableHead>Latest</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id} className={a.archived ? "opacity-60" : undefined}>
                    <TableCell className="pl-4">
                      <div className="font-medium">{a.name}</div>
                      {a.institution && (
                        <div className="text-xs text-muted-foreground">{a.institution}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1.5">
                        <Badge variant="secondary">{ACCOUNT_TYPE_LABELS[a.type]}</Badge>
                        {a.archived && <Badge variant="outline">Archived</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.txCount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {a.lastDate ? formatDate(a.lastDate, fmt.locale) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(a.balance, fmt)}
                    </TableCell>
                    <TableCell className="pr-4">
                      <AccountActions account={a} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-4" colSpan={4}>
                    Net worth (active accounts)
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatMoney(netWorth, fmt)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
        </>
      )}
    </>
  )
}
