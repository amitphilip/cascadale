"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { TrashIcon } from "@phosphor-icons/react"

import { applyRules, createRule, deleteRule, resetRules } from "@/app/actions"
import { CategoryPicker, type CategoryOption } from "@/components/category-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"

type RuleRow = { id: number; pattern: string; categoryName: string }

export function RulesPanel({
  rules,
  categories,
  uncategorized,
}: {
  rules: RuleRow[]
  categories: CategoryOption[]
  uncategorized: number
}) {
  const form = useRef<HTMLFormElement>(null)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const { pending, execute } = useServerAction()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>
          If a description contains the text, assign the category. The longest match wins.
          Rules run on every import. Merchants learned from AI and your corrections are on{" "}
          <Link href="/review" className="underline underline-offset-4">
            Review categories
          </Link>
          .
        </CardDescription>
        <CardAction className="flex gap-2">
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={pending || rules.length === 0}>
                Reset rules
              </Button>
            }
            title="Delete all rules?"
            description="All rules will be removed. Already-categorized transactions keep their category."
            confirmLabel="Reset"
            onConfirm={() => execute(() => resetRules(), { success: "Rules reset" })}
          />
          <Button
            variant="outline"
            disabled={pending || rules.length === 0 || uncategorized === 0}
            onClick={() =>
              execute(() => applyRules(), {
                success: (r) => `Categorized ${r.applied} transactions`,
              })
            }
          >
            Apply to {uncategorized} uncategorized
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6">
        <form
          ref={form}
          action={(data) =>
            execute(() => createRule(data), {
              success: (r) =>
                r.applied ? `Rule added, categorized ${r.applied} transactions` : "Rule added",
              onSuccess: () => {
                form.current?.reset()
                setCategoryId(null)
              },
            })
          }
          className="flex flex-wrap items-end gap-3"
        >
          <Field className="w-full sm:w-64">
            <FieldLabel htmlFor="rule-pattern">Description contains</FieldLabel>
            <Input id="rule-pattern" name="pattern" required minLength={2} placeholder="NETFLIX" />
          </Field>
          <Field className="w-full sm:w-56">
            <FieldLabel>Category</FieldLabel>
            <CategoryPicker
              categories={categories}
              value={categoryId}
              onValueChange={setCategoryId}
              placeholder="Choose…"
              className="w-full"
            />
            <input type="hidden" name="categoryId" value={categoryId ?? ""} />
          </Field>
          <Field orientation="horizontal" className="w-auto pb-2">
            <Checkbox id="apply-now" name="applyNow" defaultChecked />
            <FieldLabel htmlFor="apply-now" className="font-normal">
              Apply to uncategorized now
            </FieldLabel>
          </Field>
          <Button type="submit" disabled={pending || categoryId === null}>
            Add rule
          </Button>
        </form>

        {rules.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm sm:gap-3 sm:px-4">
                <code className="max-w-full rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
                  {r.pattern}
                </code>
                <span className="text-muted-foreground">→</span>
                <Badge variant="secondary">{r.categoryName}</Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`Delete rule ${r.pattern}`}
                  onClick={() => execute(() => deleteRule(r.id), { success: "Rule deleted" })}
                >
                  <TrashIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No rules yet. Add a few for your regular merchants, like your supermarket or employer.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
