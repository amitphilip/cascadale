"use client"

import { useState } from "react"
import { DotsThreeIcon } from "@phosphor-icons/react"

import { deleteTransaction, setTransactionCategory } from "@/app/actions"
import { CategoryPicker, type CategoryOption } from "@/components/category-picker"
import { TransactionDialog, type TransactionDraft } from "@/components/transaction-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useServerAction } from "@/hooks/use-server-action"

export function InlineCategory({
  txId,
  categoryId,
  categories,
  className,
}: {
  txId: number
  categoryId: number | null
  categories: CategoryOption[]
  className?: string
}) {
  const [value, setValue] = useState(categoryId)
  const { execute } = useServerAction()
  return (
    <CategoryPicker
      size="sm"
      categories={categories}
      value={value}
      className={
        className ?? (value === null ? "w-44 border-dashed text-muted-foreground" : "w-44")
      }
      onValueChange={(next) => {
        const prev = value
        setValue(next)
        execute(() => setTransactionCategory(txId, next), {
          success: (r) =>
            r.updatedSimilar
              ? `Learned. Also updated ${r.updatedSimilar} similar transactions`
              : "",
          onError: () => setValue(prev),
        })
      }}
    />
  )
}

export function TransactionRowActions({
  transaction,
  accounts,
  categories,
}: {
  transaction: TransactionDraft
  accounts: { id: number; name: string }[]
  categories: CategoryOption[]
}) {
  const [editOpen, setEditOpen] = useState(false)
  const { execute } = useServerAction()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="Transaction actions" className="max-sm:size-11" />}
        >
          <DotsThreeIcon weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit…</DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              execute(() => deleteTransaction(transaction.id), { success: "Transaction deleted" })
            }
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TransactionDialog
        transaction={transaction}
        accounts={accounts}
        categories={categories}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </>
  )
}
