"use client"

import { useState } from "react"
import {
  CalendarPlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react"

import { deleteUpcomingExpense } from "@/app/actions"
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
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"

export function LogPanel({
  accounts,
  fmt,
  upcoming,
}: {
  accounts: { id: number; name: string }[]
  fmt: MoneyFormat
  upcoming: UpcomingDraft[]
}) {
  const [importing, setImporting] = useState(false)

  return (
    <section className="grid gap-4" aria-labelledby="log-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="log-heading" className="font-heading text-lg font-semibold">
            Log
          </h2>
          <p className="text-sm text-muted-foreground">
            Add your latest statements and the one-off costs you know are coming.
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
        </div>
      </div>

      {importing && (
        <ImportWizard
          accounts={accounts}
          fmt={fmt}
          defaultOnlyNewDates
          onImported={() => setImporting(false)}
        />
      )}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Coming up</CardTitle>
          <CardDescription>One-off expenses you added.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground">
              None yet. Add things like a car service, insurance excess or a
              trip.
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
        </CardContent>
      </Card>
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
        description="It will be removed from your upcoming expenses."
        onConfirm={() =>
          execute(() => deleteUpcomingExpense(expense.id), {
            success: "Removed",
          })
        }
      />
    </li>
  )
}
