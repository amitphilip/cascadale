"use client"

import { useState } from "react"
import { CalendarPlusIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react"

import { ImportWizard } from "@/app/import/import-wizard"
import { OneOffDialog } from "@/components/one-off-dialog"
import { Button } from "@/components/ui/button"
import type { MoneyFormat } from "@/lib/format"

export function LogPanel({
  accounts,
  fmt,
  today,
}: {
  accounts: { id: number; name: string }[]
  fmt: MoneyFormat
  today: string
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
            Add your latest statements and the one-off payments you know are coming.
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
          <OneOffDialog
            accounts={accounts}
            today={today}
            trigger={
              <Button variant="outline" disabled={accounts.length === 0}>
                <CalendarPlusIcon data-icon="inline-start" />
                One-off payment
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
    </section>
  )
}
