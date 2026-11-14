"use client"

import { useState } from "react"
import { DotsThreeIcon } from "@phosphor-icons/react"

import {
  deleteTransaction,
  linkTransactionToFund,
  setTransactionCategory,
  unlinkTransactionFromFund,
} from "@/app/actions"
import { CategoryPicker, type CategoryOption } from "@/components/category-picker"
import { TransactionDialog, type TransactionDraft } from "@/components/transaction-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  funds = [],
  fund = null,
}: {
  transaction: TransactionDraft
  accounts: { id: number; name: string }[]
  categories: CategoryOption[]
  /** the live sinking funds, by name */
  funds?: string[]
  /** the fund this transaction is linked to */
  fund?: string | null
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
          {fund ? (
            <DropdownMenuItem
              onClick={() =>
                execute(() => unlinkTransactionFromFund(transaction.id), {
                  success: `Unlinked from ${fund}`,
                })
              }
            >
              Unlink from {fund}
            </DropdownMenuItem>
          ) : (
            funds.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  {transaction.amount < 0 ? "Pay from sinking fund" : "Count towards sinking fund"}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {funds.map((name) => (
                    <DropdownMenuItem
                      key={name}
                      onClick={() =>
                        execute(() => linkTransactionToFund(transaction.id, name), {
                          success:
                            transaction.amount < 0
                              ? `Paid from ${name}: it no longer counts against its category's budget`
                              : `Counted towards ${name}`,
                        })
                      }
                    >
                      {name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          )}
          <DropdownMenuSeparator />
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
