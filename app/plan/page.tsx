import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRightIcon,
  CheckIcon,
  PencilSimpleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react/ssr"

import { ActionList, AskCasButton } from "./plan-controls"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { PlanEvery, PlanPurpose, PlanVerdict } from "@/lib/db/schema"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import { getCurrentPlan, type CurrentPlan } from "@/lib/plan-data"
import { loadPlanInputs, type PlanInputs } from "@/lib/plan-inputs"
import { getSettings } from "@/lib/queries"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Plan" }

// Asking Cas for a plan is a server action on this page that can take a minute or two.
export const maxDuration = 300

const VERDICT: Record<PlanVerdict, { label: string; variant: "positive" | "warning" | "destructive"; bar: string }> = {
  realistic: { label: "Realistic", variant: "positive", bar: "bg-positive" },
  stretch: { label: "A stretch", variant: "warning", bar: "bg-warning" },
  unrealistic: { label: "Not realistic", variant: "destructive", bar: "bg-destructive" },
}

/** A small label over a group of rows. */
const EYEBROW = "text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase"

const PURPOSES: { purpose: PlanPurpose; label: string }[] = [
  { purpose: "bills", label: "Bills" },
  { purpose: "budget", label: "Budgets" },
  { purpose: "one_off", label: "One-off payments" },
  { purpose: "goal", label: "Goals" },
  { purpose: "savings", label: "Savings" },
  { purpose: "buffer", label: "Buffer" },
]

const PER_MONTH: Record<PlanEvery, number> = { week: 52 / 12, fortnight: 26 / 12, month: 1, once: 0 }
const EVERY_SUFFIX: Record<PlanEvery, string> = { week: "/wk", fortnight: "/fn", month: "/mo", once: " once" }

/** Cards hold to a phone's width with less padding. */
const TIGHT = "max-sm:[--card-spacing:--spacing(5)]"

/** Plan figures move this much from what the plan was made on before it's worth redoing. */
const STALE_SHARE = 0.05

export default async function PlanPage() {
  const [inputs, current, fmt] = await Promise.all([loadPlanInputs(), getCurrentPlan(), getSettings()])

  if (!inputs) {
    return (
      <>
        <PageHeader title="Plan" description="Cas plans from your income, budgets, bills and one-off payments." />
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            There&rsquo;s nothing to plan from yet.{" "}
            <Link href="/import" className="font-medium text-foreground underline underline-offset-4">
              Import a statement
            </Link>{" "}
            or link a bank feed first.
          </CardContent>
        </Card>
      </>
    )
  }

  const stale = current ? movedSince(current, inputs) : false

  return (
    <>
      <PageHeader
        title="Plan"
        description={
          current
            ? `Made by Cas on ${formatDate(current.plan.createdAt.slice(0, 10), fmt.locale)} from your income, budgets, bills and one-off payments.`
            : "Cas plans from your income, budgets, bills and one-off payments, and says whether your goals fit."
        }
      >
        <AskCasButton goals={current?.plan.goals ?? null} hasPlan={!!current} />
      </PageHeader>

      {current && <VerdictCard current={current} stale={stale} />}

      <FiguresCard inputs={inputs} fmt={fmt} />

      {current ? (
        // Below lg the right column dissolves into one stack, so the to-dos can sit above
        // the long list of allocations instead of under it.
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-5 lg:items-start">
          <div className="grid min-w-0 gap-6 lg:col-span-3">
            <AllocationsCard current={current} inputs={inputs} fmt={fmt} />
          </div>
          <div className="grid min-w-0 gap-6 max-lg:contents lg:col-span-2">
            {current.actions.length > 0 && (
              <Card className={cn(TIGHT, "max-lg:order-first")}>
                <CardHeader>
                  <CardTitle>To do</CardTitle>
                  <CardDescription>
                    {current.actions.filter((a) => !a.doneAt).length} of {current.actions.length} still to do. Tap to tick
                    one off.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ActionList actions={current.actions} locale={fmt.locale} />
                </CardContent>
              </Card>
            )}
            <BudgetsCard inputs={inputs} fmt={fmt} />
            <OneOffsCard inputs={inputs} fmt={fmt} />
          </div>
        </div>
      ) : (
        <>
          <Card className={TIGHT}>
            <CardHeader>
              <CardTitle>No plan yet</CardTitle>
              <CardDescription>
                Tell Cas what you&rsquo;re aiming for (or nothing at all) and it lays out where each pay goes: bills,
                budgets, one-off payments, then savings and a buffer from what&rsquo;s left. It flags any goal or
                budget that doesn&rsquo;t add up.
              </CardDescription>
            </CardHeader>
          </Card>
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <BudgetsCard inputs={inputs} fmt={fmt} />
            <OneOffsCard inputs={inputs} fmt={fmt} />
          </div>
        </>
      )}
    </>
  )
}

/** Whether income, spending or one-offs have moved enough since the plan was made to redo it. */
function movedSince(current: CurrentPlan, inputs: PlanInputs) {
  const was = current.plan.figures
  const now = inputs.figures
  const moved = (a: number, b: number) => Math.abs(a - b) > Math.max(50, Math.abs(b) * STALE_SHARE)
  return moved(was.income, now.income) || moved(was.committed, now.committed) || moved(was.oneOffs, now.oneOffs)
}

function VerdictCard({ current, stale }: { current: CurrentPlan; stale: boolean }) {
  const { plan } = current
  const v = VERDICT[plan.verdict]
  return (
    <Card className={cn(TIGHT, "relative")}>
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", v.bar)} />
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-heading text-lg font-semibold">Cas&rsquo;s read</CardTitle>
          <Badge variant={v.variant}>{v.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm max-sm:gap-3">
        <p className="max-w-[72ch] text-[0.9375rem] leading-relaxed text-pretty">{plan.verdictNote}</p>
        <p className="max-w-[80ch] text-sm leading-relaxed text-pretty text-muted-foreground">{plan.summary}</p>
        {plan.goalChecks.length > 0 && (
          <ul className="grid divide-y border-t text-sm">
            {plan.goalChecks.map((g, i) => (
              <li key={i} className="flex items-start gap-3 py-3">
                {g.fits ? (
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-positive/12">
                    <CheckIcon weight="bold" className="size-3 text-positive" aria-label="Fits" />
                  </span>
                ) : (
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                    <XIcon weight="bold" className="size-3 text-destructive" aria-label="Doesn't fit" />
                  </span>
                )}
                <span className="grid gap-0.5">
                  <span className="font-medium">{g.goal}</span>
                  <span className="text-muted-foreground">{g.note}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {stale && (
          <p className="flex items-start gap-2 rounded-xl bg-warning/8 p-3 text-sm ring-1 ring-warning/20">
            <WarningIcon weight="fill" className="mt-0.5 shrink-0 text-warning" />
            Your income, budgets or one-offs have moved since this plan was made. Ask Cas to redo it.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function FiguresCard({ inputs, fmt }: { inputs: PlanInputs; fmt: MoneyFormat }) {
  const f = inputs.figures
  const tight = f.tightBudgets.length > 0
  const tiles = [
    { label: "Income", value: f.income, hint: "Projected, per month" },
    { label: "Bills & budgets", value: f.committed, hint: tight ? `Runs at ${formatMoney(f.projectedSpend, fmt)} as things are` : "Budgets, else projections" },
    { label: "One-off payments", value: f.oneOffs, hint: `${inputs.oneOffs.length} to put money in for` },
    { label: "Left over", value: f.leftOver, hint: tight ? `${formatMoney(f.leftOverAsProjected, fmt)} if spending carries on` : "For savings, goals and a buffer", tone: f.leftOver < 0 },
  ]
  return (
    <section aria-label="This month's numbers" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label} size="sm">
          <CardHeader className="gap-1.5">
            <CardDescription className="text-xs font-medium">{t.label}</CardDescription>
            <CardTitle
              className={cn(
                "font-heading text-xl! leading-none font-semibold tabular-nums sm:text-[1.375rem]!",
                t.tone && "text-destructive"
              )}
            >
              {formatMoney(t.value, fmt)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-pretty text-muted-foreground">{t.hint}</CardContent>
        </Card>
      ))}
    </section>
  )
}

function AllocationsCard({ current, inputs, fmt }: { current: CurrentPlan; inputs: PlanInputs; fmt: MoneyFormat }) {
  const accountName = new Map(inputs.accounts.map((a) => [a.id, a.name]))
  const monthly = (a: CurrentPlan["allocations"][number]) => (a.amount ?? 0) * (a.every ? PER_MONTH[a.every] : 1)
  const total = current.allocations.reduce((s, a) => s + monthly(a), 0)
  const gap = inputs.figures.income - total
  return (
    <Card className={TIGHT}>
      <CardHeader>
        <CardTitle>Where the money goes</CardTitle>
        <CardDescription>
          {formatMoney(total, fmt)}/mo allocated of {formatMoney(inputs.figures.income, fmt)} income
          {Math.abs(gap) >= 1 && (gap > 0 ? `, ${formatMoney(gap, fmt)} unallocated` : `, ${formatMoney(-gap, fmt)} short`)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {PURPOSES.map(({ purpose, label }) => {
          const items = current.allocations.filter((a) => a.purpose === purpose)
          if (items.length === 0) return null
          return (
            <section key={purpose} className="grid gap-2">
              <h3 className={cn(EYEBROW, "flex items-baseline justify-between border-b pb-2")}>
                {label}
                <span className="tabular-nums">{formatMoney(items.reduce((s, a) => s + monthly(a), 0), fmt)}/mo</span>
              </h3>
              <ul className="grid divide-y divide-border/70">
                {items.map((a) => (
                  <li key={a.id} className="grid gap-1 py-3 first:pt-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 font-medium">{a.title}</span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatMoney(a.amount ?? 0, fmt)}
                        <span className="text-muted-foreground">{a.every ? EVERY_SUFFIX[a.every] : ""}</span>
                      </span>
                    </div>
                    {a.detail && <p className="text-sm text-muted-foreground">{a.detail}</p>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {a.accountId !== null && accountName.has(a.accountId) && <span>In {accountName.get(a.accountId)}</span>}
                      {a.every && a.every !== "month" && a.every !== "once" && (
                        <span className="tabular-nums">≈ {formatMoney(monthly(a), fmt)}/mo</span>
                      )}
                      {a.categoryId !== null && (
                        <Link
                          href={`/plan/budgets#budget-${a.categoryId}`}
                          className="inline-flex min-h-8 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline max-sm:min-h-10"
                        >
                          <PencilSimpleIcon /> Edit budget
                        </Link>
                      )}
                      {a.oneOffId !== null && (
                        <Link
                          href="/one-offs"
                          className="inline-flex min-h-8 items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline max-sm:min-h-10"
                        >
                          View one-off <ArrowRightIcon />
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </CardContent>
    </Card>
  )
}

function BudgetsCard({ inputs, fmt }: { inputs: PlanInputs; fmt: MoneyFormat }) {
  const tight = new Set(inputs.figures.tightBudgets.map((t) => t.categoryId))
  const rows = inputs.categories.filter((c) => c.categoryId !== null && (c.budget !== null || c.projected >= 1))
  return (
    <Card className={TIGHT}>
      <CardHeader>
        <CardTitle>Budgets</CardTitle>
        <CardDescription>Per month, against how each category has been running.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/plan/budgets" />}>
            Edit all
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="grid divide-y">
          {rows.map((c) => (
            <li key={c.categoryId}>
              <Link
                href={`/plan/budgets#budget-${c.categoryId}`}
                className="-mx-2 flex min-h-12 items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60"
              >
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className={cn("text-xs", tight.has(c.categoryId!) ? "text-destructive" : "text-muted-foreground")}>
                    {tight.has(c.categoryId!)
                      ? `Runs at ${formatMoney(c.projected, fmt)}, well over budget`
                      : `Runs at ${formatMoney(c.projected, fmt)}`}
                    {c.budgetPercent !== null && ` · ${c.budgetPercent}% of income`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                  {c.budget === null ? <span className="text-muted-foreground">Set</span> : formatMoney(c.budget, fmt)}
                  <PencilSimpleIcon className="text-muted-foreground" aria-label={`Edit ${c.name} budget`} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

const ONE_OFF_STATUS: Record<string, string> = {
  on_track: "On track",
  catch_up: "Behind",
  overdue: "Overdue",
}

function OneOffsCard({ inputs, fmt }: { inputs: PlanInputs; fmt: MoneyFormat }) {
  return (
    <Card className={TIGHT}>
      <CardHeader>
        <CardTitle>One-off payments</CardTitle>
        <CardDescription>What each still needs put in per month.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/one-offs" />}>
            Manage
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {inputs.oneOffs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None to pay. Add known costs like a holiday or car rego on{" "}
            <Link href="/one-offs" className="font-medium text-foreground underline underline-offset-4">
              One-off payments
            </Link>
            .
          </p>
        ) : (
          <ul className="grid divide-y">
            {inputs.oneOffs.map((o) => (
              <li key={o.oneOffId} className="flex items-center justify-between gap-3 py-2.5">
                <span className="grid min-w-0">
                  <span className="truncate font-medium">{o.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatMoney(o.held, fmt)} of {formatMoney(o.total, fmt)} · by {formatDate(o.finishDate, fmt.locale)}
                  </span>
                </span>
                <span className="grid shrink-0 justify-items-end">
                  <span className="tabular-nums">{formatMoney(o.monthly, fmt)}/mo</span>
                  <Badge variant={o.status === "on_track" ? "positive" : "destructive"}>
                    {ONE_OFF_STATUS[o.status] ?? o.status}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
