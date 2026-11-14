"use client"

import { useState } from "react"
import {
  CaretDownIcon,
  CheckCircleIcon,
  CoinsIcon,
  PlusIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react"

import {
  addSinkingFundEntry,
  removeSinkingFundEntry,
  saveSinkingFund,
} from "@/app/actions"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import { FREQUENCY_LABELS, FREQUENCIES, type Frequency } from "@/lib/plan"
import type { PotLedger } from "@/lib/pots"
import { cn } from "@/lib/utils"

/** A sinking fund as the card edits it: the pot's own fields. */
export type FundDraft = {
  name: string
  amount: number
  frequency: Frequency
  fromAccountId: number | null
  toAccountId: number | null
  cap: number | null
  endDate: string | null
  resetDate: string | null
  resetMode: "carry" | "release"
  note: string | null
}

type Account = { id: number; name: string }

const NONE = "none"
const EACH: Record<Frequency, string> = {
  payday: "each payday",
  fortnightly: "a fortnight",
  monthly: "a month",
}

/**
 * Sinking funds: pots lumpy, known costs are paid out of. Each shows its balance, what went
 * in and out this cycle, how much of its cap is used (and planned), the next draw, what to
 * set aside to get there, and its ledger with a running balance.
 */
export function SinkingFundsCard({
  ledgers,
  drafts,
  accounts,
  fmt,
  showEmpty = false,
}: {
  ledgers: PotLedger[]
  drafts: Record<string, FundDraft>
  accounts: Account[]
  fmt: MoneyFormat
  showEmpty?: boolean
}) {
  if (ledgers.length === 0 && !showEmpty) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CoinsIcon /> Sinking funds
        </CardTitle>
        <CardDescription>
          Money put by for lumpy, known costs. What&rsquo;s paid from a fund
          leaves its category&rsquo;s budget.
        </CardDescription>
        <CardAction>
          <FundDialog
            accounts={accounts}
            trigger={
              <Button variant="outline" size="sm">
                <PlusIcon data-icon="inline-start" /> New fund
              </Button>
            }
          />
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {ledgers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sinking funds yet. Make one for costs such as air tickets or
            invoices, then pay transactions from it on the Transactions page.
          </p>
        ) : (
          ledgers.map((l) => (
            <Fund
              key={l.pot.id}
              ledger={l}
              draft={drafts[l.pot.name]}
              accounts={accounts}
              fmt={fmt}
            />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function Fund({
  ledger: l,
  draft,
  accounts,
  fmt,
}: {
  ledger: PotLedger
  draft: FundDraft
  accounts: Account[]
  fmt: MoneyFormat
}) {
  const [open, setOpen] = useState(false)
  const { execute } = useServerAction()
  const money = (n: number) => formatMoney(n, fmt)
  const date = (iso: string) => formatDate(iso, fmt.locale)
  const cap = l.cap
  const spentPct = cap ? Math.min(100, (l.spent / cap.amount) * 100) : 0
  const plannedPct = cap
    ? Math.min(100 - spentPct, (l.plannedTotal / cap.amount) * 100)
    : 0
  // the suggestion line already says when the set-aside falls short
  const alerts = l.alerts.filter((a) => a.kind !== "underfunded")
  const healthy = l.alerts.length === 0
  const s = l.suggestion

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {l.pot.name}
        </span>
        {l.ended ? (
          <Badge variant="outline">Ended</Badge>
        ) : healthy ? (
          <Badge variant="outline">
            <CheckCircleIcon /> On track
          </Badge>
        ) : (
          <Badge variant="destructive">
            <WarningCircleIcon />{" "}
            {alerts.length === 0
              ? "Underfunded"
              : `${alerts.length} ${alerts.length === 1 ? "warning" : "warnings"}`}
          </Badge>
        )}
      </div>

      {cap && (
        <div className="grid gap-1.5">
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${money(l.spent)} spent and ${money(l.plannedTotal)} planned of a ${money(cap.amount)} cap`}
          >
            <div
              className={cn(
                "h-full",
                cap.remaining < 0 ? "bg-destructive" : "bg-primary"
              )}
              style={{ width: `${spentPct}%` }}
            />
            <div
              className="h-full bg-primary/35"
              style={{ width: `${plannedPct}%` }}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
            <span>
              {cap.usedPct}% of {money(cap.amount)} used
              {l.plannedTotal > 0 && ` · ${money(l.plannedTotal)} planned`}
            </span>
            <span>
              {l.cycle.end ? `to ${date(l.cycle.end)}` : "open-ended"}
              {l.cycle.nextReset && " · resets yearly"}
            </span>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Balance"
          value={money(l.balance)}
          negative={l.balance < 0}
        />
        <Stat label="Put in" value={money(l.contributed + l.carriedIn)} />
        <Stat label="Spent" value={money(l.spent)} />
        {cap ? (
          <Stat
            label="Cap left"
            value={money(cap.remaining)}
            negative={cap.remaining < 0}
          />
        ) : (
          <Stat label="Planned" value={money(l.plannedTotal)} />
        )}
      </dl>

      <div className="grid gap-1 text-sm">
        <span className="text-muted-foreground">
          {l.pot.amount > 0
            ? `Sets aside ${money(l.pot.amount)} ${EACH[l.pot.frequency]}`
            : "Nothing scheduled yet"}
          {l.carriedIn !== 0 && ` · ${money(l.carriedIn)} carried over`}
        </span>
        {s && s.perPeriod !== null && !l.ended && (
          <span>
            {s.onTrack ? "Enough: it needs " : "Set aside "}
            <span className="font-medium tabular-nums">
              {money(s.perPeriod)}
            </span>{" "}
            {EACH[s.frequency]} for {s.periods}{" "}
            {s.periods === 1 ? "period" : "periods"} to reach {money(s.target)}
            {s.until && ` by ${date(s.until)}`}.
            {!s.onTrack && (
              <FundDialog
                accounts={accounts}
                fund={{ ...draft, amount: s.perPeriod }}
                trigger={
                  <Button variant="link" size="sm" className="h-auto px-1 py-0">
                    Use this
                  </Button>
                }
              />
            )}
          </span>
        )}
        {s && s.perPeriod === null && s.need > 0 && !l.ended && (
          <span>
            No set-aside dates left: top it up by{" "}
            <span className="font-medium tabular-nums">{money(s.need)}</span>.
          </span>
        )}
      </div>

      {alerts.length > 0 && (
        <ul className="grid gap-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {alerts.map((a) => (
            <li key={a.message} className="flex gap-2">
              <WarningCircleIcon className="mt-0.5 size-4 shrink-0" />{" "}
              {a.message}
            </li>
          ))}
        </ul>
      )}

      {l.plannedDraws.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <div className="text-xs font-medium text-muted-foreground">
            Planned draws
          </div>
          <ul className="divide-y rounded-md border text-sm">
            {l.plannedDraws.map((d) => (
              <li
                key={d.entryId}
                className="flex items-center gap-2 py-1.5 pr-1 pl-3 sm:gap-3"
              >
                <span className="shrink-0 text-muted-foreground tabular-nums sm:w-24">
                  {date(d.date)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {d.name}
                  {d.overdue && (
                    <Badge variant="destructive" className="ml-2">
                      Passed
                    </Badge>
                  )}
                </span>
                <span className="tabular-nums">{money(d.amount)}</span>
                <span
                  className={cn(
                    "hidden w-24 text-right text-xs tabular-nums sm:block",
                    d.balanceAfter < 0
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                  title="The fund's balance after it"
                >
                  {money(d.balanceAfter)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${d.name}`}
                  onClick={() =>
                    execute(() => removeSinkingFundEntry(d.entryId), {
                      success: "Planned draw removed",
                    })
                  }
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <EntryDialog
          pot={l.pot.name}
          kind="planned_draw"
          trigger={
            <Button variant="outline" size="sm">
              Plan a draw
            </Button>
          }
        />
        <EntryDialog
          pot={l.pot.name}
          kind="contribution"
          trigger={
            <Button variant="outline" size="sm">
              Top up
            </Button>
          }
        />
        <FundDialog
          accounts={accounts}
          fund={draft}
          trigger={
            <Button variant="ghost" size="sm">
              Edit
            </Button>
          }
        />
        {l.lines.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Ledger ({l.lines.length})
            <CaretDownIcon
              data-icon="inline-end"
              className={cn("transition-transform", open && "rotate-180")}
            />
          </Button>
        )}
      </div>

      {open && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-1.5 text-left font-medium">Date</th>
                <th className="px-3 py-1.5 text-left font-medium">What</th>
                <th className="px-3 py-1.5 text-right font-medium">In / out</th>
                <th className="px-3 py-1.5 text-right font-medium">Balance</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {l.lines.toReversed().map((line, i) => (
                <tr key={`${line.date}-${line.kind}-${line.entryId ?? i}`}>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums">
                    {date(line.date)}
                  </td>
                  <td
                    className="max-w-56 truncate px-3 py-1.5"
                    title={line.note ?? undefined}
                  >
                    {line.note ??
                      (line.kind === "draw" ? "Draw" : "Contribution")}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right whitespace-nowrap tabular-nums",
                      line.amount > 0 && "text-primary"
                    )}
                  >
                    {line.amount === 0
                      ? "-"
                      : formatMoney(line.amount, fmt, { signed: true })}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right whitespace-nowrap tabular-nums",
                      line.balance < 0 && "text-destructive"
                    )}
                  >
                    {money(line.balance)}
                  </td>
                  <td className="pr-2">
                    {line.entryId !== null &&
                      line.transactionId === null &&
                      line.kind === "contribution" && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove this top-up"
                          onClick={() =>
                            execute(
                              () => removeSinkingFundEntry(line.entryId!),
                              { success: "Top-up removed" }
                            )
                          }
                        >
                          <XIcon />
                        </Button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
            {l.linked.count} linked{" "}
            {l.linked.count === 1 ? "transaction" : "transactions"}:{" "}
            {money(l.linked.drawn)} drawn
            {l.linked.contributed > 0 &&
              `, ${money(l.linked.contributed)} paid in`}
            . Scheduled set-asides are counted on their dates.
          </p>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  negative,
}: {
  label: string
  value: string
  negative?: boolean
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-heading font-semibold tabular-nums",
          negative && "text-destructive"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function FundDialog({
  fund,
  accounts,
  trigger,
}: {
  fund?: FundDraft
  accounts: Account[]
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()
  const accountItems = (none: string) => [
    { value: NONE, label: none },
    ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
  ]
  const fromItems = accountItems("Not set yet")
  const toItems = accountItems("Keep it in the from account")
  const frequencyItems = FREQUENCIES.map((f) => ({
    value: f,
    label: FREQUENCY_LABELS[f],
  }))
  const resetItems = [
    { value: "carry", label: "Carry the balance over" },
    { value: "release", label: "Release what's left" },
  ]
  const editing = !!fund?.name

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger render={trigger} />
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form
          key={JSON.stringify(fund ?? null)}
          action={(form) =>
            execute(() => saveSinkingFund(form), {
              success: editing ? "Sinking fund updated" : "Sinking fund added",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${fund.name}` : "New sinking fund"}
            </DialogTitle>
            <DialogDescription>
              Set money aside on a schedule for known, lumpy costs, then pay
              them from it. Leave the amount at 0 to get a suggestion.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sf-name">Name</FieldLabel>
              <Input
                id="sf-name"
                name="name"
                required
                readOnly={editing}
                defaultValue={fund?.name}
                placeholder="AOC invoices"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sf-amount">Set aside</FieldLabel>
                <Input
                  id="sf-amount"
                  name="amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  defaultValue={fund?.amount ?? 0}
                />
              </Field>
              <Field>
                <FieldLabel>How often</FieldLabel>
                <Select
                  name="frequency"
                  items={frequencyItems}
                  defaultValue={fund?.frequency ?? "monthly"}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {frequencyItems.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>From</FieldLabel>
                <Select
                  name="fromAccountId"
                  items={fromItems}
                  defaultValue={
                    fund?.fromAccountId ? String(fund.fromAccountId) : NONE
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fromItems.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Needed once it sets money aside.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Kept in</FieldLabel>
                <Select
                  name="toAccountId"
                  items={toItems}
                  defaultValue={
                    fund?.toAccountId ? String(fund.toAccountId) : NONE
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {toItems.map((a) => (
                      <SelectItem key={a.value} value={a.value}>
                        {a.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sf-cap">Cap (optional)</FieldLabel>
                <Input
                  id="sf-cap"
                  name="cap"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  defaultValue={fund?.cap ?? ""}
                  placeholder="7500"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sf-end">Ends (optional)</FieldLabel>
                <Input
                  id="sf-end"
                  name="endDate"
                  type="date"
                  defaultValue={fund?.endDate ?? ""}
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sf-reset">Resets yearly on</FieldLabel>
                <Input
                  id="sf-reset"
                  name="resetDate"
                  type="date"
                  defaultValue={fund?.resetDate ?? ""}
                />
                <FieldDescription>
                  Optional: the cap and totals start again each year.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>At a reset</FieldLabel>
                <Select
                  name="resetMode"
                  items={resetItems}
                  defaultValue={fund?.resetMode ?? "carry"}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {resetItems.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="sf-note">Note (optional)</FieldLabel>
              <Input
                id="sf-note"
                name="note"
                defaultValue={fund?.note ?? ""}
                placeholder="Invoiced payments to April"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save" : "Add fund"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EntryDialog({
  pot,
  kind,
  trigger,
}: {
  pot: string
  kind: "planned_draw" | "contribution"
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()
  const draw = kind === "planned_draw"

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <form
          action={(form) =>
            execute(() => addSinkingFundEntry(form), {
              success: draw ? "Draw planned" : "Top-up recorded",
              onSuccess: () => setOpen(false),
            })
          }
          className="grid gap-6"
        >
          <DialogHeader>
            <DialogTitle>
              {draw ? `Plan a draw on ${pot}` : `Top up ${pot}`}
            </DialogTitle>
            <DialogDescription>
              {draw
                ? "An expected one-off this fund pays. The plan takes it from the fund, not from day-to-day spending."
                : "Money put in beyond the scheduled set-aside."}
            </DialogDescription>
          </DialogHeader>
          <input type="hidden" name="pot" value={pot} />
          <input type="hidden" name="kind" value={kind} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${kind}-name`}>
                {draw ? "What for" : "Note (optional)"}
              </FieldLabel>
              <Input
                id={`${kind}-name`}
                name="name"
                required={draw}
                placeholder={draw ? "Air tickets" : "Bonus"}
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${kind}-amount`}>Amount</FieldLabel>
                <Input
                  id={`${kind}-amount`}
                  name="amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${kind}-date`}>
                  {draw ? "When" : "Date"}
                </FieldLabel>
                <Input id={`${kind}-date`} name="date" type="date" required />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : draw ? "Plan it" : "Top up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
