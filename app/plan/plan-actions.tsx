"use client"

import { useRef } from "react"
import { ListPlusIcon, TrashIcon } from "@phosphor-icons/react"

import { addPlanAction, deletePlanAction, setPlanActionDone } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate } from "@/lib/format"
import type { PlanAction } from "@/lib/db/schema"
import { cn } from "@/lib/utils"

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
  return (
    <div className="grid gap-4">
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to do yet. Add an action below, or from a focus item.
        </p>
      ) : (
        <ul className="grid gap-2">
          {actions.map((a) => {
            const done = a.doneAt !== null
            const overdue = !done && a.dueDate !== null && a.dueDate < today
            return (
              <li key={a.id} className="flex items-start gap-3 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={done}
                  disabled={pending}
                  aria-label={`${done ? "Reopen" : "Mark done"}: ${a.title}`}
                  onCheckedChange={(checked) =>
                    execute(() => setPlanActionDone(a.id, checked === true))
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className={cn("text-pretty", done && "text-muted-foreground line-through")}>
                    {a.title}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {done ? (
                      <>Done {formatDate(a.doneAt!.slice(0, 10), locale)}</>
                    ) : a.dueDate ? (
                      <span className={cn(overdue && "font-medium text-destructive")}>
                        {overdue ? "Overdue · " : "Due "}
                        {formatDate(a.dueDate, locale)}
                      </span>
                    ) : null}
                    {a.createdBy === "mcp" && <span>{done || a.dueDate ? " · " : ""}Added by Claude</span>}
                    {a.detail && <span> {done || a.dueDate ? "· " : ""}{a.detail}</span>}
                  </div>
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
          })}
        </ul>
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
        <Input name="dueDate" type="date" aria-label="Due date" className="w-40" />
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </form>
    </div>
  )
}

/** Turn a focus item into an action item. */
export function AddFocusAction({
  title,
  detail,
  added,
}: {
  title: string
  detail: string
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
            form.set("focusTitle", title)
            return addPlanAction(form)
          },
          { success: "Added to action items" }
        )
      }
    >
      <ListPlusIcon />
      {added ? "In action items" : "Add to action items"}
    </Button>
  )
}
