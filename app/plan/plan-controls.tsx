"use client"

import { useState } from "react"
import { CheckCircleIcon, CircleIcon, SparkleIcon } from "@phosphor-icons/react"

import { askCasForPlan, setPlanItemDone } from "@/app/plan/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Opens a box for your goals and asks Cas to make the plan from them. */
export function AskCasButton({ goals, hasPlan }: { goals: string | null; hasPlan: boolean }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(goals ?? "")
  const { pending, execute } = useServerAction()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        setOpen(next)
        if (next) setText(goals ?? "")
      }}
    >
      <DialogTrigger render={<Button className="max-sm:w-full" />}>
        <SparkleIcon data-icon="inline-start" />
        {hasPlan ? "Ask Cas to redo the plan" : "Ask Cas for a plan"}
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            execute(() => askCasForPlan(text), {
              success: "Cas has made your plan",
              onSuccess: () => setOpen(false),
            })
          }}
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>What should the plan aim for?</DialogTitle>
            <DialogDescription>
              Cas works from your projected income, the budgets you&rsquo;ve set, your bills and your one-off
              payments, and tells you straight if a goal doesn&rsquo;t fit.
            </DialogDescription>
          </DialogHeader>
          {pending ? (
            <div className="grid gap-3" aria-live="polite">
              <p className="text-sm text-muted-foreground">
                Cas is working out your plan. This takes a minute or so.
              </p>
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <Field>
              <FieldLabel htmlFor="plan-goals">Your goals (optional)</FieldLabel>
              <Textarea
                id="plan-goals"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                maxLength={2000}
                className="text-base"
                placeholder={"e.g. Save $10,000 for a house deposit by next December\nPay off the Visa by March\nKeep $2,000 as a buffer"}
              />
              <FieldDescription>Amounts and dates help Cas say whether each one fits.</FieldDescription>
            </Field>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending} className="max-sm:w-full">
              {pending ? "Making your plan…" : "Make the plan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The plan's actions as a checklist. */
export function ActionList({
  actions,
  locale,
}: {
  actions: { id: number; title: string; detail: string | null; dueDate: string | null; doneAt: string | null }[]
  locale: string
}) {
  const { pending, execute } = useServerAction()
  const today = new Date().toISOString().slice(0, 10)
  return (
    <ul className="grid gap-2">
      {actions.map((a) => {
        const done = a.doneAt !== null
        const overdue = !done && a.dueDate !== null && a.dueDate < today
        return (
          <li key={a.id}>
            <button
              type="button"
              disabled={pending}
              aria-pressed={done}
              onClick={() =>
                execute(() => setPlanItemDone(a.id, !done), { success: done ? "Reopened" : "Done" })
              }
              className="flex min-h-11 w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              {done ? (
                <CheckCircleIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-primary" />
              ) : (
                <CircleIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              )}
              <span className="grid min-w-0 gap-0.5">
                <span className={cn("font-medium", done && "text-muted-foreground line-through")}>{a.title}</span>
                {a.detail && <span className="text-sm text-muted-foreground">{a.detail}</span>}
                {a.dueDate && (
                  <span className={cn("text-xs", overdue ? "text-destructive" : "text-muted-foreground")}>
                    {overdue ? "Overdue · " : "By "}
                    {formatDate(a.dueDate, locale)}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
