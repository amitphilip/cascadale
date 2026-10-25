"use client"

import { useState } from "react"
import {
  CalendarPlusIcon,
  PencilSimpleIcon,
  SparkleIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react"

import { checkIn, deleteUpcomingExpense } from "@/app/actions"
import { CheckInView, StatusBadge } from "@/app/check-in-view"
import { ImportWizard } from "@/app/import/import-wizard"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  UpcomingDialog,
  type UpcomingDraft,
} from "@/components/upcoming-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useServerAction } from "@/hooks/use-server-action"
import type { CheckIn } from "@/lib/db/schema"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"

/** Recurring bills listed before "N more". */
const MAX_BILLS = 8

export type UpcomingBill = {
  date: string
  name: string
  amount: number
  account: string
}

export function LogPanel({
  accounts,
  fmt,
  upcoming,
  bills,
  checkIns,
}: {
  accounts: { id: number; name: string }[]
  fmt: MoneyFormat
  upcoming: UpcomingDraft[]
  /** recurring bills in the next 30 days */
  bills: UpcomingBill[]
  /** newest first */
  checkIns: CheckIn[]
}) {
  const [importing, setImporting] = useState(false)
  const { pending, execute } = useServerAction()
  const [latest, ...earlier] = checkIns

  const runCheckIn = () =>
    execute(() => checkIn(), {
      success: "Check-in ready",
    })

  return (
    <section className="grid gap-4" aria-labelledby="log-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="log-heading" className="font-heading text-lg font-semibold">
            Log
          </h2>
          <p className="text-sm text-muted-foreground">
            Add your latest statements and what’s coming up. Claude checks them
            against your plan.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={importing ? "secondary" : "default"}
            onClick={() => setImporting((v) => !v)}
          >
            {importing ? (
              <XIcon data-icon="inline-start" />
            ) : (
              <UploadSimpleIcon data-icon="inline-start" />
            )}
            {importing ? "Close" : "Add statement"}
          </Button>
          <UpcomingDialog
            accounts={accounts}
            trigger={
              <Button variant="outline">
                <CalendarPlusIcon data-icon="inline-start" />
                Upcoming expense
              </Button>
            }
          />
          <Button variant="outline" onClick={runCheckIn} disabled={pending}>
            <SparkleIcon data-icon="inline-start" />
            {pending ? "Checking in…" : "Check in"}
          </Button>
        </div>
      </div>

      {importing && (
        <ImportWizard
          accounts={accounts}
          fmt={fmt}
          defaultOnlyNewDates
          onImported={({ inserted }) => {
            setImporting(false)
            if (inserted > 0) runCheckIn()
          }}
        />
      )}

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SparkleIcon /> Check-in
            </CardTitle>
            <CardDescription>
              What changed since you last logged, and what to do about it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {pending ? (
              <div className="grid gap-3" aria-live="polite">
                <p className="text-sm text-muted-foreground">
                  Reading your new transactions against the plan. This can take
                  a minute.
                </p>
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : latest ? (
              <CheckInView
                stats={latest.stats}
                result={latest.result}
                createdAt={latest.createdAt}
                fmt={fmt}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No check-ins yet. Add a statement, or check in on what you’ve
                already logged.
              </p>
            )}

            {earlier.length > 0 && (
              <details className="mt-5 border-t pt-4 text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Earlier check-ins ({earlier.length})
                </summary>
                <ul className="mt-3 grid gap-3">
                  {earlier.map((c) => (
                    <li key={c.id} className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge status={c.result.status} />
                        {new Date(c.createdAt).toLocaleDateString(fmt.locale, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                        {" · "}
                        {formatDate(c.periodStart, fmt.locale)} –{" "}
                        {formatDate(c.periodEnd, fmt.locale)}
                      </div>
                      <span className="font-medium">{c.result.headline}</span>
                      <p className="text-muted-foreground">
                        {c.result.paragraph}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Coming up</CardTitle>
            <CardDescription>
              One-offs you added, and recurring bills in the next 30 days.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-5 text-sm">
            <div className="grid grid-cols-1 gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                One-off expenses
              </h3>
              {upcoming.length === 0 ? (
                <p className="text-muted-foreground">
                  None yet. Add things like a car service, insurance excess or a
                  trip so the plan can make room for them.
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-2">
                  {upcoming.map((u) => (
                    <UpcomingRow
                      key={u.id}
                      expense={u}
                      accounts={accounts}
                      fmt={fmt}
                    />
                  ))}
                </ul>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                Recurring bills
              </h3>
              {bills.length === 0 ? (
                <p className="text-muted-foreground">
                  No recurring bills detected in the next 30 days.
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-1.5">
                  {bills.slice(0, MAX_BILLS).map((b, i) => (
                    <li
                      key={i}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate">{b.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(b.date, fmt.locale)} · {b.account}
                        </div>
                      </div>
                      <span className="shrink-0 tabular-nums">
                        {formatMoney(b.amount, fmt)}
                      </span>
                    </li>
                  ))}
                  {bills.length > MAX_BILLS && (
                    <li className="text-xs text-muted-foreground">
                      and {bills.length - MAX_BILLS} more,{" "}
                      {formatMoney(
                        bills
                          .slice(MAX_BILLS)
                          .reduce((s, b) => s + b.amount, 0),
                        fmt
                      )}{" "}
                      in total
                    </li>
                  )}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}

function UpcomingRow({
  expense,
  accounts,
  fmt,
}: {
  expense: UpcomingDraft
  accounts: { id: number; name: string }[]
  fmt: MoneyFormat
}) {
  const { pending, execute } = useServerAction()
  const account = accounts.find((a) => a.id === expense.accountId)?.name
  return (
    <li className="flex items-center gap-2 rounded-lg border p-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-medium">{expense.name}</span>
          <span className="shrink-0 font-medium tabular-nums">
            {formatMoney(expense.amount, fmt)}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {formatDate(expense.dueDate, fmt.locale)}
          {account && ` · ${account}`}
          {expense.note && ` · ${expense.note}`}
        </div>
      </div>
      <UpcomingDialog
        expense={expense}
        accounts={accounts}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${expense.name}`}
          >
            <PencilSimpleIcon />
          </Button>
        }
      />
      <ConfirmDialog
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${expense.name}`}
            disabled={pending}
          >
            <TrashIcon />
          </Button>
        }
        title={`Delete “${expense.name}”?`}
        description="It will no longer be planned for."
        onConfirm={() =>
          execute(() => deleteUpcomingExpense(expense.id), {
            success: "Removed",
          })
        }
      />
    </li>
  )
}
