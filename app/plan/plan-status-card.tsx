import {
  CaretRightIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/ssr"

import { CheckInButton } from "./check-in-button"
import { CheckInView, StatusBadge } from "@/app/check-in-view"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { CHECK_IN_STATUS_LABELS, type CheckInStatus } from "@/lib/checkin-types"
import type { CasNote, CheckIn } from "@/lib/db/schema"
import { formatDate, type MoneyFormat } from "@/lib/format"
import type { Standing, Verdict } from "@/lib/plan-verdict"
import { cn } from "@/lib/utils"
import { localDate } from "@/supabase/functions/_shared/akahu"

const GOOD = "text-positive"
const BAD = "text-destructive"

const TONE: Record<
  CheckInStatus,
  {
    card: string
    text: string
    Icon: React.ComponentType<{ className?: string }>
  }
> = {
  on_track: {
    card: "border-positive/40 bg-positive/5",
    text: GOOD,
    Icon: CheckCircleIcon,
  },
  watch: { card: "", text: "text-foreground", Icon: WarningCircleIcon },
  off_track: {
    card: "border-destructive/40 bg-destructive/5",
    text: BAD,
    Icon: WarningCircleIcon,
  },
}

/**
 * Is the plan on track? One status from two questions: are you following it (the last
 * check-in) and does it hold up (the simulation's verdict), with what Cas has noticed.
 */
export function PlanStatusCard({
  standing,
  verdict,
  checkIn,
  notes,
  fmt,
}: {
  standing: Standing
  verdict: Verdict
  /** the latest check-in, or null before the first */
  checkIn: CheckIn | null
  /** Cas's open observations and to-dos */
  notes: CasNote[]
  fmt: MoneyFormat
}) {
  const { card, text, Icon } = TONE[standing.status]
  const date = (iso: string) => formatDate(iso, fmt.locale)
  return (
    <Card className={card} aria-labelledby="plan-standing">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusBadge status={standing.status} />
          {checkIn ? (
            <span>
              Last check-in {date(localDate(checkIn.createdAt))}:{" "}
              {CHECK_IN_STATUS_LABELS[checkIn.result.status].toLowerCase()} ·{" "}
              {date(checkIn.periodStart)} – {date(checkIn.periodEnd)}
            </span>
          ) : (
            <span>No check-in yet</span>
          )}
        </div>
        <CardTitle
          id="plan-standing"
          className={cn("flex items-start gap-2 text-xl text-balance", text)}
        >
          <Icon className="mt-0.5 size-6 shrink-0" /> {standing.headline}
        </CardTitle>
        {standing.stale && (
          <CardDescription className="text-pretty">
            {standing.unchecked === null
              ? "Nothing has been compared with the plan yet. Check in to see whether you’re following it."
              : `${standing.unchecked} days of transactions since the last check-in haven’t been compared with the plan. Check in to see whether you’re still following it.`}
          </CardDescription>
        )}
        <CardAction>
          <CheckInButton />
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <VerdictList
            title="Needs attention"
            items={verdict.bad}
            Icon={WarningCircleIcon}
            color={BAD}
          />
          <VerdictList
            title="Going well"
            items={verdict.good}
            Icon={CheckCircleIcon}
            color={GOOD}
          />
        </div>

        {notes.length > 0 && (
          <details className="group min-w-0 border-t pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              <ChatCircleTextIcon /> What Cas noticed · {notes.length}
            </summary>
            <ul className="mt-4 grid gap-2 text-sm">
              {notes.map((n) => (
                <li key={n.id} className="flex items-start gap-2 text-pretty">
                  <Badge
                    variant="outline"
                    className="mt-0.5 shrink-0 capitalize"
                  >
                    {n.kind === "todo" ? "To do" : n.kind}
                  </Badge>
                  <span>
                    {n.content}
                    {n.dueDate && (
                      <span className="text-muted-foreground">
                        {" "}
                        · by {date(n.dueDate)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {checkIn && (
          <details className="group min-w-0 border-t pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <CaretRightIcon className="transition-transform group-open:rotate-90" />
              Read the last check-in
            </summary>
            <div className="mt-4 min-w-0">
              <CheckInView
                stats={checkIn.stats}
                result={checkIn.result}
                createdAt={checkIn.createdAt}
                fmt={fmt}
              />
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

function VerdictList({
  title,
  items,
  Icon,
  color,
}: {
  title: string
  items: string[]
  Icon: React.ComponentType<{ className?: string }>
  color: string
}) {
  return (
    <div className="grid content-start gap-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing right now.</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-pretty">
              <Icon className={cn("mt-0.5 size-4 shrink-0", color)} />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
