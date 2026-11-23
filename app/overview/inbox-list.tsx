"use client"

import { useOptimistic, useState, useTransition } from "react"
import Link from "next/link"
import { BellRingingIcon, CaretRightIcon, CheckCircleIcon, CircleIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { completeInboxItem } from "@/app/inbox-actions"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/lib/format"
import { cn } from "@/lib/utils"

/** What lib/inbox.ts's InboxItem carries, as the page passes it down. */
export type InboxRow = {
  key: string
  source: "plan" | "cas" | "nudge"
  title: string
  detail: string | null
  dueDate: string | null
  createdAt: string
  href: string | null
}

/** Shown before "Show all". */
const FIRST = 5

const SOURCE_LABEL: Record<InboxRow["source"], string> = {
  nudge: "From Cas",
  plan: "From your plan",
  cas: "Cas to-do",
}

/** Everything that needs you, most urgent first: Cas's messages, then to-dos by due date. */
export function InboxList({ items, today, locale }: { items: InboxRow[]; today: string; locale: string }) {
  const [shown, removeShown] = useOptimistic(items, (rows, key: string) => rows.filter((r) => r.key !== key))
  const [, startTransition] = useTransition()
  const [all, setAll] = useState(false)

  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing needs you right now.</p>
  }

  function done(item: InboxRow) {
    startTransition(async () => {
      removeShown(item.key)
      try {
        const res = await completeInboxItem(item.key)
        if (res.ok) toast.success(item.source === "nudge" ? "Dismissed" : "Done")
        else toast.error(res.error)
      } catch {
        toast.error("Couldn't reach the server. Try again.")
      }
    })
  }

  const visible = all ? shown : shown.slice(0, FIRST)
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {visible.map((item) => (
          <InboxEntry key={item.key} item={item} today={today} locale={locale} onDone={() => done(item)} />
        ))}
      </ul>
      {shown.length > FIRST && (
        <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${shown.length}`}
        </Button>
      )}
    </div>
  )
}

function due(dueDate: string, today: string, locale: string) {
  if (dueDate < today) return { text: `Overdue · was due ${formatDate(dueDate, locale)}`, urgent: true }
  if (dueDate === today) return { text: "Due today", urgent: true }
  return { text: `Due ${formatDate(dueDate, locale)}`, urgent: false }
}

function InboxEntry({
  item,
  today,
  locale,
  onDone,
}: {
  item: InboxRow
  today: string
  locale: string
  onDone: () => void
}) {
  const nudge = item.source === "nudge"
  // "review" clears itself once the merchants are categorised, so it has nothing to tick
  const tickable = item.key !== "review"
  const when = item.dueDate ? due(item.dueDate, today, locale) : null

  const body = (
    <span className="grid min-w-0 gap-0.5">
      <span className={cn("text-xs font-medium", nudge ? "text-primary" : "text-muted-foreground")}>
        {SOURCE_LABEL[item.source]}
      </span>
      <span className="font-medium text-pretty">{item.title}</span>
      {item.detail && <span className="text-sm text-pretty text-muted-foreground">{item.detail}</span>}
      {when && (
        <span className={cn("text-xs", when.urgent ? "font-medium text-destructive" : "text-muted-foreground")}>
          {when.text}
        </span>
      )}
    </span>
  )

  return (
    <li
      className={cn(
        "flex items-start gap-1 rounded-lg border",
        nudge && "border-primary/30 bg-primary/5"
      )}
    >
      {nudge ? (
        <span className="flex size-11 shrink-0 items-center justify-center" aria-hidden>
          <BellRingingIcon weight="fill" className="size-5 text-primary" />
        </span>
      ) : tickable ? (
        <button
          type="button"
          onClick={onDone}
          aria-label={`Mark done: ${item.title}`}
          className="group flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted/60"
        >
          <CircleIcon className="size-5 text-muted-foreground group-hover:hidden" />
          <CheckCircleIcon weight="fill" className="hidden size-5 text-primary group-hover:block" />
        </button>
      ) : (
        <span className="flex size-11 shrink-0 items-center justify-center" aria-hidden>
          <CircleIcon className="size-5 text-muted-foreground/50" />
        </span>
      )}

      {item.href ? (
        <Link
          href={item.href}
          className="flex min-w-0 flex-1 items-start justify-between gap-2 py-2.5 pr-3 hover:bg-muted/40 rounded-r-lg"
        >
          {body}
          <CaretRightIcon className="mt-5 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
      ) : (
        <div className="min-w-0 flex-1 py-2.5 pr-3">{body}</div>
      )}

      {nudge && (
        <Button variant="ghost" size="sm" className="my-1.5 mr-1.5 shrink-0" onClick={onDone}>
          Got it
        </Button>
      )}
    </li>
  )
}
