"use client"

import { useEffect, useRef, useState } from "react"
import { PaperPlaneRightIcon, SparkleIcon } from "@phosphor-icons/react"

import { askPlanner } from "@/app/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useServerAction } from "@/hooks/use-server-action"
import { cn } from "@/lib/utils"

export type ChatMessage = {
  id: number
  role: "user" | "assistant"
  content: string
  /** this reply revised the plan */
  changed: boolean
}

const STARTERS = [
  "Explain the plan in simple terms",
  "Add an emergency fund pot",
  "What happens if my rent goes up 10%?",
  "Which bills could I cut first?",
]

export function PlanChat({ threadId, messages }: { threadId: number; messages: ChatMessage[] }) {
  const [draft, setDraft] = useState("")
  const [sent, setSent] = useState<string | null>(null)
  const { pending, execute } = useServerAction()
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = end.current
    if (!el || el.getClientRects().length === 0) return
    el.scrollIntoView({ block: "nearest" })
  }, [messages.length, sent])

  function send(text: string) {
    const message = text.trim()
    if (!message || pending) return
    setSent(message)
    setDraft("")
    execute(() => askPlanner(threadId, message), {
      success: (r) => (r.changed ? "Plan updated" : ""),
      onSuccess: () => setSent(null),
      onError: () => {
        setSent(null)
        setDraft(message)
      },
    })
  }

  const shown = sent
    ? [...messages, { id: -1, role: "user" as const, content: sent, changed: false }]
    : messages

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="-mx-(--card-spacing) min-h-0 flex-1 overflow-y-auto px-(--card-spacing)">
        <div className="grid gap-3">
          {shown.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[90%] rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap",
                m.role === "user"
                  ? "justify-self-end bg-primary text-primary-foreground"
                  : "justify-self-start bg-muted"
              )}
            >
              {m.content}
              {m.changed && (
                <div className="mt-2">
                  <Badge variant="outline" className="bg-background">
                    <SparkleIcon /> Plan updated
                  </Badge>
                </div>
              )}
            </div>
          ))}
          {pending && (
            <div className="justify-self-start rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              Thinking…
            </div>
          )}
          <div ref={end} />
        </div>
      </div>

      {messages.length <= 2 && !pending && (
        <div className="flex max-w-full flex-wrap gap-1.5">
          {STARTERS.map((s) => (
            <Button
              key={s}
              variant="outline"
              size="xs"
              className="h-auto max-w-full whitespace-normal text-left"
              onClick={() => send(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
        className="flex items-end gap-2"
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(draft)
            }
          }}
          rows={2}
          placeholder="Ask a question or request a change…"
          aria-label="Message the planner"
          className="min-h-0 resize-none"
          disabled={pending}
        />
        <Button type="submit" size="icon" disabled={pending || !draft.trim()} aria-label="Send">
          <PaperPlaneRightIcon />
        </Button>
      </form>
    </div>
  )
}
