"use client"

import { useMemo, useRef, useState } from "react"
import Link from "next/link"
import { FileCsvIcon, PlusIcon, UploadSimpleIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { commitImport } from "@/app/actions"
import { AccountDialog } from "@/components/account-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useServerAction } from "@/hooks/use-server-action"
import { formatDate, formatMoney, type MoneyFormat } from "@/lib/format"
import {
  DATE_FORMATS,
  applyMapping,
  type ParsedRow,
  detectDateFormats,
  detectStatementInfo,
  guessMapping,
  type Mapping,
} from "@/lib/import/parse"
import { cn } from "@/lib/utils"

type Upload = { storedName: string; fileName: string; rows: string[][] }

const NONE = "__none"
const PREVIEW_ROWS = 50

export function ImportWizard({
  accounts,
  initialAccountId,
  fmt,
  defaultOnlyNewDates = false,
  onImported,
}: {
  accounts: { id: number; name: string }[]
  initialAccountId?: number
  fmt: MoneyFormat
  /** start with "only add dates not already imported" ticked */
  defaultOnlyNewDates?: boolean
  onImported?: (result: { inserted: number }) => void
}) {
  const [accountId, setAccountId] = useState<string | null>(
    initialAccountId ? String(initialAccountId) : accounts[0] ? String(accounts[0].id) : null
  )
  const [upload, setUpload] = useState<Upload | null>(null)
  const [mapping, setMapping] = useState<Mapping | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [onlyNewDates, setOnlyNewDates] = useState(defaultOnlyNewDates)
  const fileInput = useRef<HTMLInputElement>(null)
  const { pending, execute } = useServerAction()

  const accountItems = accounts.map((a) => ({ value: String(a.id), label: a.name }))

  async function handleFile(file: File) {
    setUploading(true)
    try {
      const body = new FormData()
      body.set("file", file)
      const res = await fetch("/api/statements/upload", { method: "POST", body })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Upload failed")
      setUpload(json)
      setMapping(guessMapping(json.rows))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  function reset() {
    setUpload(null)
    setMapping(null)
  }

  const preview = useMemo(
    () => (upload && mapping ? applyMapping(upload.rows, mapping) : null),
    [upload, mapping]
  )

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>1. Choose account and file</CardTitle>
          <CardDescription>
            Export a CSV from your bank or card provider. Re-importing overlapping statements is
            safe: rows already imported are skipped.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
          <Field>
            <FieldLabel>Account</FieldLabel>
            {accounts.length > 0 ? (
              <Select
                items={accountItems}
                value={accountId}
                onValueChange={(v) => setAccountId(v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an account" />
                </SelectTrigger>
                <SelectContent>
                  {accountItems.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <FieldDescription>You need an account to import into.</FieldDescription>
            )}
            <AccountDialog
              onSaved={(id) => setAccountId(String(id))}
              trigger={
                <Button variant="outline" size="sm" className="w-fit">
                  <PlusIcon data-icon="inline-start" />
                  New account
                </Button>
              }
            />
          </Field>

          {upload ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
              <FileCsvIcon className="size-8 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{upload.fileName}</div>
                <div className="text-sm text-muted-foreground">
                  {upload.rows.length} rows read
                </div>
              </div>
              <Button variant="ghost" onClick={reset}>
                Choose another file
              </Button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!accountId || uploading}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                const file = e.dataTransfer.files[0]
                if (file && accountId) handleFile(file)
              }}
              className={cn(
                "flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50",
                dragging && "border-primary bg-muted/50"
              )}
            >
              <UploadSimpleIcon className="size-6" />
              <span>
                {uploading
                  ? "Reading file…"
                  : accountId
                    ? "Drop a CSV here, or click to browse"
                    : "Add an account first"}
              </span>
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFile(file)
            }}
          />
        </CardContent>
      </Card>

      {upload && mapping && preview && (
        <>
          <MappingCard
            rows={upload.rows}
            mapping={mapping}
            onChange={setMapping}
            parsed={preview.parsed}
            fmt={fmt}
          />

          <Card>
            <CardHeader>
              <CardTitle>3. Review</CardTitle>
              <CardDescription>
                {preview.parsed.length} transactions
                {preview.parsed.length > 0 && (
                  <>
                    {" "}
                    from {formatDate(minDate(preview.parsed), fmt.locale)} to{" "}
                    {formatDate(maxDate(preview.parsed), fmt.locale)}
                  </>
                )}
                {" · "}in{" "}
                {formatMoney(
                  preview.parsed.reduce((s, r) => s + Math.max(r.amount, 0), 0),
                  fmt
                )}
                {" · "}out{" "}
                {formatMoney(
                  preview.parsed.reduce((s, r) => s + Math.min(r.amount, 0), 0) * -1,
                  fmt
                )}
                {preview.skipped.length > 0 && (
                  <> · {preview.skipped.length} rows skipped</>
                )}
              </CardDescription>
              <CardAction>
                <Button
                  disabled={pending || !accountId || preview.parsed.length === 0}
                  onClick={() =>
                    execute(
                      () =>
                        commitImport({
                          storedName: upload.storedName,
                          fileName: upload.fileName,
                          accountId: Number(accountId),
                          mapping,
                          onlyNewDates,
                        }),
                      {
                        success: (r) =>
                          `Imported ${r.inserted} transactions` +
                          (r.existingDates
                            ? `, ${r.existingDates} skipped on dates already imported`
                            : "") +
                          (r.duplicates ? `, ${r.duplicates} already existed` : "") +
                          (r.categorized ? `. ${r.categorized} matched by rules` : "") +
                          (r.aiCategorized ? `, ${r.aiCategorized} categorized by AI` : "") +
                          ".",
                        onSuccess: (r) => {
                          if (r.aiError) {
                            toast.warning("AI categorization didn't run", {
                              description: r.aiError,
                            })
                          }
                          reset()
                          onImported?.(r)
                        },
                      }
                    )
                  }
                >
                  {pending ? "Importing…" : `Import ${preview.parsed.length} transactions`}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Field orientation="horizontal">
                <Checkbox
                  id="only-new-dates"
                  checked={onlyNewDates}
                  onCheckedChange={(v) => setOnlyNewDates(Boolean(v))}
                />
                <FieldLabel htmlFor="only-new-dates" className="font-normal">
                  Only add dates not already imported for this account
                </FieldLabel>
              </Field>
              {preview.parsed.length > 0 && (
                <div className="overflow-hidden rounded-lg border">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">Line</TableHead>
                        <TableHead className="w-32">Date</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.parsed.slice(0, PREVIEW_ROWS).map((r) => (
                        <TableRow key={r.line}>
                          <TableCell className="text-muted-foreground tabular-nums">
                            {r.line}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {formatDate(r.date, fmt.locale)}
                          </TableCell>
                          <TableCell className="max-w-0 truncate">{r.description}</TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              r.amount > 0 && "text-primary"
                            )}
                          >
                            {formatMoney(r.amount, fmt, { signed: true })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {preview.parsed.length > PREVIEW_ROWS && (
                <p className="text-sm text-muted-foreground">
                  Showing the first {PREVIEW_ROWS} of {preview.parsed.length}.
                </p>
              )}
              {preview.skipped.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    {preview.skipped.length} skipped rows (headers, totals, or unreadable)
                  </summary>
                  <ul className="mt-2 grid gap-1 font-mono text-xs">
                    {preview.skipped.slice(0, 30).map((s) => (
                      <li key={s.line} className="truncate">
                        <Badge variant="outline" className="mr-2">
                          {s.reason}
                        </Badge>
                        line {s.line}: {s.raw}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
            <CardFooter className="text-sm text-muted-foreground">
              Categorization rules run automatically on import. Tune them on the{" "}
              <Link href="/categories" className="ml-1 underline underline-offset-4">
                categories page
              </Link>
              .
            </CardFooter>
          </Card>
        </>
      )}
    </div>
  )
}

function minDate(rows: { date: string }[]) {
  return rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date)
}
function maxDate(rows: { date: string }[]) {
  return rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date)
}

/** Up to `n` distinct non-empty values per column, from the data rows. */
function columnSamples(rows: string[][], headerRow: number, n = 3) {
  const width = rows[headerRow]?.length ?? 0
  const out: string[][] = Array.from({ length: width }, () => [])
  for (const row of rows.slice(headerRow + 1)) {
    for (let i = 0; i < width; i++) {
      const v = row[i]?.trim()
      if (v && out[i].length < n && !out[i].includes(v)) out[i].push(v)
    }
    if (out.every((s) => s.length >= n)) break
  }
  return out
}

function MappingCard({
  rows,
  mapping,
  onChange,
  parsed,
  fmt,
}: {
  rows: string[][]
  mapping: Mapping
  onChange: (m: Mapping) => void
  parsed: ParsedRow[]
  fmt: MoneyFormat
}) {
  const headers = rows[mapping.headerRow] ?? []
  const columnItems = headers.map((h, i) => ({
    value: String(i),
    label: h.trim() || `Column ${i + 1}`,
  }))
  const optionalItems = [{ value: NONE, label: "—" }, ...columnItems]

  const validFormats = useMemo(
    () => detectDateFormats(rows.slice(mapping.headerRow + 1).map((r) => r[mapping.date] ?? "")),
    [rows, mapping.headerRow, mapping.date]
  )
  const formatItems = [
    ...validFormats.map((f) => ({ value: f, label: `${f}  ✓` })),
    ...DATE_FORMATS.filter((f) => !validFormats.includes(f)).map((f) => ({
      value: f,
      label: f,
    })),
  ]
  const samples = useMemo(
    () => columnSamples(rows, mapping.headerRow),
    [rows, mapping.headerRow]
  )
  const info = useMemo(
    () => detectStatementInfo(rows, mapping.headerRow),
    [rows, mapping.headerRow]
  )
  const from = info.from ?? (parsed.length > 0 ? minDate(parsed) : null)
  const to = info.to ?? (parsed.length > 0 ? maxDate(parsed) : null)

  const set = (patch: Partial<Mapping>) => onChange({ ...mapping, ...patch })

  function columnSelect({
    label,
    value,
    optional,
    onValue,
  }: {
    label: string
    value: number | null
    optional?: boolean
    onValue: (v: number | null) => void
  }) {
    const items = optional ? optionalItems : columnItems
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <Select
          items={items}
          value={value === null ? NONE : String(value)}
          onValueChange={(v) => onValue(v === NONE || v == null ? null : Number(v))}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} className="max-h-72">
            {items.map((c) => {
              const ex = c.value === NONE ? [] : (samples[Number(c.value)] ?? [])
              return (
                <SelectItem key={c.value} value={c.value}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0">{c.label}</span>
                    {ex.length > 0 && (
                      <span className="truncate text-xs text-muted-foreground">{ex[0]}</span>
                    )}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {value !== null && (
          <FieldDescription className="truncate" title={samples[value]?.join("  ·  ")}>
            {samples[value]?.length
              ? `e.g. ${samples[value].join("  ·  ")}`
              : "Empty in every row"}
          </FieldDescription>
        )}
      </Field>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Map columns</CardTitle>
        <CardDescription>
          Detected automatically. Adjust if the preview below looks wrong.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="header-row">Header row</FieldLabel>
            <Input
              id="header-row"
              type="number"
              min={1}
              max={rows.length}
              value={mapping.headerRow + 1}
              onChange={(e) => {
                const n = Math.min(Math.max(Number(e.target.value) || 1, 1), rows.length) - 1
                onChange(guessMapping(rows, n))
              }}
            />
            <FieldDescription>Line number holding column names.</FieldDescription>
          </Field>
          {columnSelect({
            label: "Date",
            value: mapping.date,
            onValue: (v) => {
              const date = v ?? 0
              const formats = detectDateFormats(
                rows.slice(mapping.headerRow + 1).map((r) => r[date] ?? "")
              )
              set({ date, dateFormat: formats[0] ?? mapping.dateFormat })
            },
          })}
          <Field>
            <FieldLabel>Date format</FieldLabel>
            <Select
              items={formatItems}
              value={mapping.dateFormat}
              onValueChange={(v) => set({ dateFormat: v as string })}
            >
              <SelectTrigger className="w-full font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="max-h-72 font-mono">
                {formatItems.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {validFormats.length > 1
                ? "Several formats fit. Check day vs month in the preview."
                : validFormats.length === 0
                  ? "No format fits most rows. Check the date column."
                  : "Detected from the data."}
            </FieldDescription>
          </Field>
          {columnSelect({
            label: "Description",
            value: mapping.description,
            onValue: (v) => set({ description: v ?? 0 }),
          })}
          {columnSelect({
            label: "Extra description",
            value: mapping.description2,
            optional: true,
            onValue: (v) => set({ description2: v }),
          })}
          <Field>
            <FieldLabel>Amounts</FieldLabel>
            <Select
              items={[
                { value: "single", label: "One signed column" },
                { value: "split", label: "Separate debit / credit" },
              ]}
              value={mapping.amountMode}
              onValueChange={(v) => set({ amountMode: v as Mapping["amountMode"] })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">One signed column</SelectItem>
                <SelectItem value="split">Separate debit / credit</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mapping.amountMode === "single" ? (
            columnSelect({
              label: "Amount",
              value: mapping.amount,
              optional: true,
              onValue: (v) => set({ amount: v }),
            })
          ) : (
            <>
              {columnSelect({
                label: "Debit (money out)",
                value: mapping.debit,
                optional: true,
                onValue: (v) => set({ debit: v }),
              })}
              {columnSelect({
                label: "Credit (money in)",
                value: mapping.credit,
                optional: true,
                onValue: (v) => set({ credit: v }),
              })}
            </>
          )}
          <Field orientation="horizontal" className="self-center">
            <Checkbox
              id="invert"
              checked={mapping.invert}
              onCheckedChange={(v) => set({ invert: Boolean(v) })}
            />
            <FieldLabel htmlFor="invert" className="font-normal">
              Flip signs (spending shows as positive)
            </FieldLabel>
          </Field>
        </FieldGroup>

        <dl className="mt-6 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Account number</dt>
          <dd className="tabular-nums">
            {info.account ?? <span className="text-muted-foreground">Not found in file</span>}
            {info.accountName && (
              <span className="text-muted-foreground"> · {info.accountName}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Statement period</dt>
          <dd className="tabular-nums">
            {from && to ? (
              <>
                {formatDate(from, fmt.locale)} – {formatDate(to, fmt.locale)}
                {!(info.from && info.to) && (
                  <span className="text-muted-foreground"> · from transaction dates</span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </dd>
        </dl>

        <div className="mt-4 rounded-lg border bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Reads as{parsed.length > 3 ? ` (first 3 of ${parsed.length})` : ""}
          </div>
          {parsed.length === 0 ? (
            <p className="text-sm text-destructive">
              No rows can be read with this mapping. Check the header row, date and amount columns.
            </p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {parsed.slice(0, 3).map((r, i) => (
                <li key={i} className="flex items-baseline gap-3">
                  <span className="w-28 shrink-0 text-muted-foreground tabular-nums">
                    {formatDate(r.date, fmt.locale)}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={r.description}>
                    {r.description}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-medium tabular-nums",
                      r.amount > 0 && "text-primary"
                    )}
                  >
                    {formatMoney(r.amount, fmt, { signed: true })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
