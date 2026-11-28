"use client"

import { ArrowsClockwiseIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { syncAkahu } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

export function AkahuSyncButton({ disabled }: { disabled?: boolean }) {
  const { pending, execute } = useServerAction()

  return (
    <Button
      variant="outline"
      disabled={pending || disabled}
      onClick={() =>
        execute(() => syncAkahu(), {
          success: (r) =>
            (r.addedAccounts
              ? `Added ${r.addedAccounts} account${r.addedAccounts === 1 ? "" : "s"}. `
              : "") +
            `Synced ${r.inserted} new transactions` +
            (r.categorized ? `. ${r.categorized} matched by rules` : "") +
            ".",
          onSuccess: (r) => {
            if (r.failedAccounts) {
              toast.warning(
                `${r.failedAccounts} account${r.failedAccounts === 1 ? "" : "s"} didn't sync`,
                { description: "See the error under each account in Settings, Import & sync." }
              )
            }
          },
        })
      }
    >
      <ArrowsClockwiseIcon data-icon="inline-start" />
      {pending ? "Syncing…" : "Sync now"}
    </Button>
  )
}
