"use client"

import Link from "next/link"
import { DotsThreeIcon } from "@phosphor-icons/react"

import { deleteAccount, setAccountArchived } from "@/app/actions"
import { AccountDialog } from "@/components/account-dialog"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useServerAction } from "@/hooks/use-server-action"
import type { Account } from "@/lib/db/schema"

export function AccountActions({
  account,
}: {
  account: Pick<Account, "id" | "name" | "type" | "institution" | "openingBalance" | "archived">
}) {
  const { execute } = useServerAction()

  return (
    <div className="flex justify-end gap-1">
      <AccountDialog account={account} trigger={<Button variant="ghost" size="sm">Edit</Button>} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
        >
          <DotsThreeIcon weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<Link href={`/transactions?account=${account.id}`} />}>
            View transactions
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={`/import?account=${account.id}`} />}>
            Import statement
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              execute(() => setAccountArchived(account.id, !account.archived), {
                success: account.archived ? "Account restored" : "Account archived",
              })
            }
          >
            {account.archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm" className="text-destructive">
            Delete
          </Button>
        }
        title={`Delete “${account.name}”?`}
        description="This permanently deletes the account, all its transactions, and its imported statement files."
        onConfirm={() => execute(() => deleteAccount(account.id), { success: "Account deleted" })}
      />
    </div>
  )
}
