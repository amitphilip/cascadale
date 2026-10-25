import { Badge } from "@/components/ui/badge"
import {
  CHECK_IN_STATUS_LABELS,
  type CheckInResult,
  type CheckInStats,
  type CheckInStatus,
} from "@/lib/checkin-types"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATUS_CLASS: Record<CheckInStatus, string> = {
  on_track: "bg-foreground text-background",
  watch: "bg-foreground/10 text-foreground",
  off_track: "bg-destructive/10 text-destructive",
}

/** Categories that moved this much from their expectation are called out. */
const NOTABLE_DIFF = 0.15

export function StatusBadge({ status }: { status: CheckInStatus }) {
  return (
    <Badge className={STATUS_CLASS[status]}>
      {CHECK_IN_STATUS_LABELS[status]}
    </Badge>
  )
}

export function CheckInView({
  stats,
  result,
  createdAt,
  fmt,
}: {
  stats: CheckInStats
  result: CheckInResult
  createdAt: string
  fmt: MoneyFormat
}) {
  const money = (n: number, signed = false) => formatMoney(n, fmt, { signed })
  const date = (iso: string) => formatDate(iso, fmt.locale)
  const notable = stats.categories
    .filter(
      (c) =>
        Math.abs(c.spent - c.expected) >=
        Math.max(c.expected * NOTABLE_DIFF, 10)
    )
    .sort(
      (a, b) => Math.abs(b.spent - b.expected) - Math.abs(a.spent - a.expected)
    )
    .slice(0, 6)

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <StatusBadge status={result.status} />
          <span>
            {new Date(createdAt).toLocaleDateString(fmt.locale, {
              day: "numeric",
              month: "short",
            })}{" "}
            ·{" "}
            {stats.basis === "new"
              ? `${stats.newCount} new transactions, ${date(stats.from)} – ${date(stats.to)}`
              : `Nothing new logged · last ${stats.days} days`}
          </span>
        </div>
        <p className="font-heading text-lg leading-snug font-semibold text-balance">
          {result.headline}
        </p>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
          {result.paragraph}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Came in"
          value={money(stats.income)}
          hint={`usual ${money(stats.expectedIncome)}`}
        />
        <Metric
          label="Went out"
          value={money(stats.spending)}
          hint={`usual ${money(stats.expectedSpending)}`}
          bad={stats.spending > stats.expectedSpending * 1.1}
        />
        <Metric
          label="Net"
          value={money(stats.net, true)}
          bad={stats.net < 0}
        />
        <Metric
          label="Cash now"
          value={money(stats.cashNow)}
          hint={
            stats.low
              ? `low ${money(stats.low.balance)} on ${date(stats.low.date)}`
              : undefined
          }
          bad={(stats.low?.balance ?? 0) < 0}
        />
      </dl>

      {result.actions.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">What to do now</h3>
          <ol className="grid gap-2">
            {result.actions.map((a, i) => (
              <li key={i} className="flex gap-3 rounded-lg border p-3 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-medium">{a.title}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {a.amount !== null && money(a.amount)}
                      {a.amount !== null && a.by && " · "}
                      {a.by && `by ${date(a.by)}`}
                    </span>
                  </div>
                  <p className="text-muted-foreground">{a.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.plan_changes.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">When the plan shifts</h3>
          <ul className="grid gap-0 border-l pl-4">
            {result.plan_changes.map((c, i) => (
              <li key={i} className="relative pb-3 text-sm last:pb-0">
                <span
                  className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary"
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium tabular-nums">
                    {date(c.date)}
                  </span>
                  {c.amount !== null && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {money(c.amount)}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground">{c.change}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="group text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Analytics behind this check-in
        </summary>
        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          {notable.length > 0 && (
            <Section title="Categories off their usual pace">
              {notable.map((c) => (
                <Row
                  key={c.name}
                  left={c.name}
                  right={`${money(c.spent)} vs ${money(c.expected)}`}
                  bad={c.spent > c.expected}
                />
              ))}
            </Section>
          )}
          {stats.incomeItems.length > 0 && (
            <Section title="Money in">
              {stats.incomeItems.map((r, i) => (
                <Row
                  key={i}
                  left={`${date(r.date)} · ${r.description}`}
                  right={money(r.amount)}
                />
              ))}
            </Section>
          )}
          {stats.bigExpenses.length > 0 && (
            <Section title="Largest money out">
              {stats.bigExpenses.map((r, i) => (
                <Row
                  key={i}
                  left={`${date(r.date)} · ${r.description}`}
                  right={money(r.amount)}
                />
              ))}
            </Section>
          )}
        </div>
      </details>
    </div>
  )
}

function Metric({
  label,
  value,
  hint,
  bad,
}: {
  label: string
  value: string
  hint?: string
  bad?: boolean
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-heading text-base font-semibold tabular-nums",
          bad && "text-destructive"
        )}
      >
        {value}
      </dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="grid content-start gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="grid gap-1">{children}</ul>
    </div>
  )
}

function Row({
  left,
  right,
  bad,
}: {
  left: string
  right: string
  bad?: boolean
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate">{left}</span>
      <span className={cn("shrink-0 tabular-nums", bad && "text-destructive")}>
        {right}
      </span>
    </li>
  )
}
