"use client"

import { useState } from "react"
import { LinkIcon, XIcon } from "@phosphor-icons/react"

import {
  deleteOneOff,
  linkOneOffTransactions,
  unlinkOneOffTransaction,
} from "@/app/actions"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { OneOffDialog, type OneOffDraft } from "@/components/one-off-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import type { LinkedTx } from "@/lib/one-offs"
import { cn } from "@/lib/utils"

export function OneOffActions({
  oneOff,
  accounts,
  today,
}: {
  oneOff: OneOffDraft
  accounts: { id: number; name: string }[]
  today: string
}) {
  const { execute } = useServerAction()
  return (
    <div className="flex justify-end gap-1">
      <OneOffDialog
        oneOff={oneOff}
        accounts={accounts}
        today={today}
        trigger={
          <Button variant="ghost" size="sm">
            Edit
          </Button>
        }
      />
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive">
            Delete
          </Button>
        }
        title={`Delete “${oneOff.name}”?`}
        description="This deletes the one-off payment. Its transactions stay where they are; they just stop counting towards it."
        onConfirm={() =>
          execute(() => deleteOneOff(oneOff.id), { success: "One-off payment deleted" })
        }
      />
    </div>
  )
}

/** Choose transactions in the one-off's account to count towards it. */
export function LinkTransactionsDialog({
  oneOff,
  candidates,
  fmt,
}: {
  oneOff: { id: number; name: string; accountName: string }
  candidates: LinkedTx[]
  fmt: MoneyFormat
}) {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const { pending, execute } = useServerAction()
  const toggle = (txId: number, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s)
      if (on) next.add(txId)
      else next.delete(txId)
      return next
    })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        setOpen(o)
        if (o) setChosen(new Set())
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <LinkIcon data-icon="inline-start" />
            Link transactions
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link to “{oneOff.name}”</DialogTitle>
          <DialogDescription>
            Money into {oneOff.accountName} for it, and payments out of it. Transactions another
            one-off already counts aren&rsquo;t listed.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unlinked transactions in {oneOff.accountName} since it started.
          </p>
        ) : (
          <ul className="-mx-2 grid max-h-80 gap-0.5 overflow-y-auto">
            {candidates.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                  <Checkbox
                    checked={chosen.has(t.id)}
                    onCheckedChange={(on) => toggle(t.id, Boolean(on))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{t.description}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(t.date, fmt.locale)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-sm tabular-nums",
                      t.amount > 0 && "text-emerald-600 dark:text-emerald-400"
                    )}
                  >
                    {formatMoney(t.amount, fmt, { signed: true })}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            disabled={pending || chosen.size === 0}
            onClick={() =>
              execute(() => linkOneOffTransactions(oneOff.id, [...chosen]), {
                success: (r) => `Linked ${r.count} transaction${r.count === 1 ? "" : "s"}`,
                onSuccess: () => setOpen(false),
              })
            }
          >
            {pending ? "Linking…" : chosen.size > 0 ? `Link ${chosen.size}` : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function UnlinkButton({ transactionId }: { transactionId: number }) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Stop counting this transaction"
      disabled={pending}
      onClick={() =>
        execute(() => unlinkOneOffTransaction(transactionId), { success: "Transaction unlinked" })
      }
    >
      <XIcon />
    </Button>
  )
}
