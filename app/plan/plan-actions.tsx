"use client"

import { useRef } from "react"
import { CaretRightIcon, ListPlusIcon, TrashIcon } from "@phosphor-icons/react"

import {
  addPlanAction,
  deletePlanAction,
  setPlanActionDone,
} from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate } from "@/lib/format"
import type { PlanAction } from "@/lib/db/schema"
import { cn } from "@/lib/utils"

/** Your action items: open ones first, with a form to add one; done ones folded away. */
export function ActionItems({
  actions,
  today,
  locale,
}: {
  actions: PlanAction[]
  today: string
  locale: string
}) {
  const { pending, execute } = useServerAction()
  const formRef = useRef<HTMLFormElement>(null)
  const open = actions.filter((a) => a.doneAt === null)
  const done = actions.filter((a) => a.doneAt !== null)

  const row = (a: PlanAction) => {
    const finished = a.doneAt !== null
    const overdue = !finished && a.dueDate !== null && a.dueDate < today
    const meta = [
      finished ? (
        <span key="done">
          Done {formatDate(a.doneAt!.slice(0, 10), locale)}
        </span>
      ) : a.dueDate ? (
        <span
          key="due"
          className={cn(overdue && "font-medium text-destructive")}
        >
          {overdue ? "Overdue · " : "Due "}
          {formatDate(a.dueDate, locale)}
        </span>
      ) : null,
      a.createdBy === "mcp" ? <span key="by">Added by Claude</span> : null,
      a.detail ? <span key="detail">{a.detail}</span> : null,
    ].filter(Boolean)
    return (
      <li key={a.id} className="flex items-start gap-3 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={finished}
          disabled={pending}
          aria-label={`${finished ? "Reopen" : "Mark done"}: ${a.title}`}
          onCheckedChange={(checked) =>
            execute(() => setPlanActionDone(a.id, checked === true))
          }
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-pretty",
              finished && "text-muted-foreground line-through"
            )}
          >
            {a.title}
          </div>
          {meta.length > 0 && (
            <div className="text-xs text-pretty text-muted-foreground">
              {meta.map((m, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete ${a.title}`}
          disabled={pending}
          onClick={() => execute(() => deletePlanAction(a.id))}
        >
          <TrashIcon />
        </Button>
      </li>
    )
  }

  return (
    <div className="grid gap-4">
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to do right now. Add one below, or pick a suggestion.
        </p>
      ) : (
        <ul className="grid gap-2.5">{open.map(row)}</ul>
      )}
      <form
        ref={formRef}
        action={(form) =>
          execute(() => addPlanAction(form), {
            success: "Action added",
            onSuccess: () => formRef.current?.reset(),
          })
        }
        className="flex flex-wrap gap-2"
      >
        <Input
          name="title"
          required
          maxLength={120}
          placeholder="Add an action…"
          aria-label="New action"
          className="min-w-48 flex-1"
        />
        <Input
          name="dueDate"
          type="date"
          aria-label="Due date"
          className="w-40"
        />
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </form>
      {done.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CaretRightIcon className="transition-transform group-open:rotate-90" />
            {done.length} done
          </summary>
          <ul className="mt-3 grid gap-2.5">{done.map(row)}</ul>
        </details>
      )}
    </div>
  )
}

/** Turn a suggestion (a focus item from the plan, or a check-in's advice) into an action item. */
export function AddSuggestedAction({
  title,
  detail,
  dueDate,
  added,
}: {
  title: string
  detail: string
  dueDate?: string | null
  added: boolean
}) {
  const { pending, execute } = useServerAction()
  return (
    <Button
      size="sm"
      variant="ghost"
      className="w-fit"
      disabled={pending || added}
      onClick={() =>
        execute(
          () => {
            const form = new FormData()
            form.set("title", title)
            form.set("detail", detail)
            if (dueDate) form.set("dueDate", dueDate)
            form.set("focusTitle", title)
            return addPlanAction(form)
          },
          { success: "Added to your actions" }
        )
      }
    >
      <ListPlusIcon />
      {added ? "In your actions" : "Add to actions"}
    </Button>
  )
}
