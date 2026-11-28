"use client"

import { CheckCircleIcon, CircleIcon } from "@phosphor-icons/react"

import { setPlanItemDone } from "@/app/plan/actions"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

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
    <ul className="-mx-2 grid divide-y divide-border/70">
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
              className="flex min-h-11 w-full items-start gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
            >
              {done ? (
                <CheckCircleIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-positive" />
              ) : (
                <CircleIcon className="mt-0.5 size-5 shrink-0 text-foreground/30" />
              )}
              <span className="grid min-w-0 gap-0.5">
                <span className={cn("font-medium", done && "text-muted-foreground line-through")}>{a.title}</span>
                {a.detail && <span className="text-sm text-muted-foreground">{a.detail}</span>}
                {a.dueDate && (
                  <span className={cn("text-xs tabular-nums", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
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
