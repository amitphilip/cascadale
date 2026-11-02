import {
  CaretRightIcon,
  LightbulbIcon,
  ListChecksIcon,
} from "@phosphor-icons/react/ssr"

import { ActionItems, AddSuggestedAction } from "./plan-actions"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { PlanAction } from "@/lib/db/schema"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import type { PRIORITIES } from "@/lib/plan"
import { cn } from "@/lib/utils"

/** Something the plan or a check-in suggests doing, not yet one of your actions. */
export type Suggestion = {
  key: string
  title: string
  detail: string
  /** where it came from, e.g. "From the plan" or "Check-in 15 Oct" */
  source: string
  priority?: (typeof PRIORITIES)[number]
  /** estimated monthly saving or gain */
  impact?: number | null
  /** money involved, when it's a one-off move */
  amount?: number | null
  dueDate?: string | null
}

const PRIORITY_DOT = {
  high: "bg-destructive",
  medium: "bg-foreground/60",
  low: "bg-muted-foreground/50",
} as const

/** What to do: your action items, then what the plan and the last check-in suggest. */
export function PlanTodoCard({
  actions,
  suggestions,
  today,
  fmt,
}: {
  actions: PlanAction[]
  suggestions: Suggestion[]
  today: string
  fmt: MoneyFormat
}) {
  const open = actions.filter((a) => a.doneAt === null).length
  const done = actions.length - open
  // a suggestion already taken up: by its own title, whether or not it's been done
  const taken = new Map(
    actions.flatMap((a) =>
      [a.title, a.focusTitle].flatMap((t) =>
        t ? [[t.toLowerCase(), a.doneAt !== null] as const] : []
      )
    )
  )
  const shown = suggestions.filter(
    (s) => taken.get(s.title.toLowerCase()) !== true
  )
  const money = (n: number) =>
    formatMoney(n, fmt, { compact: Math.abs(n) >= 10000 })

  return (
    <Card id="todo">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecksIcon /> What to do
        </CardTitle>
        <CardDescription>
          {open} to do
          {done > 0 && ` · ${done} done`}
          {shown.length > 0 && ` · ${shown.length} suggested`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <ActionItems actions={actions} today={today} locale={fmt.locale} />

        {shown.length > 0 && (
          <details className="group min-w-0 border-t pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              <LightbulbIcon /> Suggested · {shown.length}
            </summary>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {shown.map((s) => (
                <li
                  key={s.key}
                  className="grid content-start gap-1.5 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {s.priority && (
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          PRIORITY_DOT[s.priority]
                        )}
                        title={`${s.priority} priority`}
                        aria-label={`${s.priority} priority`}
                      />
                    )}
                    <span>{s.source}</span>
                    {s.impact ? (
                      <Badge
                        variant="secondary"
                        className="ml-auto shrink-0 tabular-nums"
                      >
                        ~{money(Math.abs(s.impact))}/mo
                      </Badge>
                    ) : s.amount ? (
                      <Badge
                        variant="secondary"
                        className="ml-auto shrink-0 tabular-nums"
                      >
                        {money(s.amount)}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="font-medium text-pretty">{s.title}</div>
                  <p className="text-sm text-pretty text-muted-foreground">
                    {s.detail}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {s.dueDate
                        ? `By ${formatDate(s.dueDate, fmt.locale)}`
                        : ""}
                    </span>
                    <AddSuggestedAction
                      title={s.title}
                      detail={s.detail}
                      dueDate={s.dueDate}
                      added={taken.has(s.title.toLowerCase())}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
