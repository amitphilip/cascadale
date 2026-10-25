import { format, isValid, parse } from "date-fns"

/**
 * Pure statement-parsing helpers, shared by the import preview (client) and
 * the import commit (server) so both see exactly the same result.
 */

export type Mapping = {
  headerRow: number
  date: number
  description: number
  description2: number | null
  amountMode: "single" | "split"
  amount: number | null
  debit: number | null
  credit: number | null
  /** Flip signs, e.g. credit-card exports where purchases are positive. */
  invert: boolean
  dateFormat: string
}

export type ParsedRow = {
  line: number
  date: string
  description: string
  amount: number
}

export type SkippedRow = { line: number; reason: string; raw: string }

export const DATE_FORMATS = [
  "yyyy-M-d",
  "d/M/yyyy",
  "M/d/yyyy",
  "d-M-yyyy",
  "M-d-yyyy",
  "d.M.yyyy",
  "yyyy/M/d",
  "d MMM yyyy",
  "d-MMM-yyyy",
  "d MMM yy",
  "d-MMM-yy",
  "MMM d, yyyy",
  "d/M/yy",
  "M/d/yy",
  "d-M-yy",
] as const

const REF_DATE = new Date(2000, 0, 1)

function cleanDateText(value: string) {
  return value
    .trim()
    .replace(/T\d.*$/, "")
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s?[AP]M)?$/i, "")
}

export function parseDate(value: string, fmt: string): string | null {
  const text = cleanDateText(value)
  if (!text) return null
  const d = parse(text, fmt, REF_DATE)
  if (!isValid(d)) return null
  const y = d.getFullYear()
  if (y < 1970 || y > 2100) return null
  return format(d, "yyyy-MM-dd")
}

/**
 * Formats that parse the most sample values (at least half, so stray
 * footer/total rows don't defeat detection), best guess first.
 */
export function detectDateFormats(values: string[]): string[] {
  const sample = values.map((v) => v.trim()).filter(Boolean).slice(0, 200)
  if (sample.length === 0) return []
  const scored = DATE_FORMATS.map((fmt) => ({
    fmt,
    hits: sample.filter((v) => parseDate(v, fmt) !== null).length,
  }))
  const best = Math.max(...scored.map((s) => s.hits))
  if (best < Math.ceil(sample.length / 2)) return []
  return scored.filter((s) => s.hits === best).map((s) => s.fmt)
}

export function parseAmount(value: string | undefined | null): number | null {
  if (value == null) return null
  let s = value.trim()
  if (!s || s === "-") return null
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  if (/\s*(dr|db)\.?$/i.test(s)) {
    negative = true
    s = s.replace(/\s*(dr|db)\.?$/i, "")
  } else if (/\s*cr\.?$/i.test(s)) {
    s = s.replace(/\s*cr\.?$/i, "")
  }
  if (s.endsWith("-")) {
    negative = true
    s = s.slice(0, -1)
  }
  s = s.replace(/[^\d.,\-+]/g, "")
  if (s.startsWith("-")) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith("+")) {
    s = s.slice(1)
  }
  // European style: 1.234,56 or 12,5
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".")
  } else {
    s = s.replace(/,/g, "")
  }
  if (!/^\d*\.?\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round((negative ? -n : n) * 100) / 100
}

function nonEmpty(row: string[]) {
  return row.filter((c) => c && c.trim()).length
}

export function detectHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 40)
  for (let i = 0; i < limit; i++) {
    if (nonEmpty(rows[i]) >= 3 && rows[i].some((c) => /date/i.test(c))) return i
  }
  for (let i = 0; i < limit; i++) {
    if (nonEmpty(rows[i]) >= 3) return i
  }
  return 0
}

/** Fallback: the column (other than `exclude`) whose values most often parse as amounts. */
function mostNumericColumn(data: string[][], exclude: number[]): number | null {
  const sample = data.slice(0, 50)
  const width = Math.max(0, ...sample.map((r) => r.length))
  let best: number | null = null
  let bestHits = 0
  for (let c = 0; c < width; c++) {
    if (exclude.includes(c)) continue
    const hits = sample.filter((r) => parseAmount(r[c]) !== null).length
    if (hits > bestHits) {
      best = c
      bestHits = hits
    }
  }
  return bestHits >= Math.ceil(sample.length / 2) ? best : null
}

function findCol(headers: string[], patterns: RegExp[], exclude?: RegExp) {
  for (const re of patterns) {
    const idx = headers.findIndex(
      (h) => re.test(h) && !(exclude && exclude.test(h))
    )
    if (idx !== -1) return idx
  }
  return null
}

export function guessMapping(rows: string[][], headerRowOverride?: number): Mapping {
  const headerRow = headerRowOverride ?? detectHeaderRow(rows)
  const headers = (rows[headerRow] ?? []).map((h) => h.trim().toLowerCase())
  const data = rows.slice(headerRow + 1)

  const date =
    findCol(
      headers,
      [/^(transaction|txn|trans\.?|posting|posted|booking)\s*date/, /date/],
      /value date/
    ) ??
    findCol(headers, [/date/]) ??
    0
  const description =
    findCol(headers, [
      /description|narration|particulars|details|memo|payee|merchant|verwendungszweck|libell|concepto|omschrijving/,
      /name|remarks|reference|transaction|beschreibung/,
    ]) ?? (date === 0 ? 1 : 0)
  const amount =
    findCol(headers, [/^amount$/, /amount|betrag|montant|importe|bedrag|valor/], /balance|saldo|solde/) ??
    mostNumericColumn(data, [date, description])
  const debit = findCol(
    headers,
    [/debit|withdrawal|paid out|money out|^dr\b|outflow/],
    /balance/
  )
  const credit = findCol(
    headers,
    [/credit|deposit|paid in|money in|^cr\b|inflow/],
    /balance|card/
  )
  const amountMode =
    debit !== null && credit !== null && debit !== credit ? "split" : "single"

  const dateFormat =
    detectDateFormats(data.map((r) => r[date] ?? ""))[0] ?? DATE_FORMATS[0]

  return {
    headerRow,
    date,
    description,
    description2: null,
    amountMode,
    amount: amount ?? (amountMode === "single" ? (debit ?? credit) : null),
    debit,
    credit,
    invert: false,
    dateFormat,
  }
}

export function applyMapping(
  rows: string[][],
  m: Mapping
): { parsed: ParsedRow[]; skipped: SkippedRow[] } {
  const parsed: ParsedRow[] = []
  const skipped: SkippedRow[] = []

  for (let i = m.headerRow + 1; i < rows.length; i++) {
    const row = rows[i]
    const line = i + 1
    if (!row || nonEmpty(row) === 0) continue
    const raw = row.join(", ")

    const date = parseDate(row[m.date] ?? "", m.dateFormat)
    if (!date) {
      skipped.push({ line, reason: "Unreadable date", raw })
      continue
    }

    let amount: number | null
    if (m.amountMode === "single") {
      amount = m.amount === null ? null : parseAmount(row[m.amount])
    } else {
      const debit = m.debit === null ? null : parseAmount(row[m.debit])
      const credit = m.credit === null ? null : parseAmount(row[m.credit])
      amount =
        debit === null && credit === null
          ? null
          : (credit ? Math.abs(credit) : 0) - (debit ? Math.abs(debit) : 0)
    }
    if (amount === null) {
      skipped.push({ line, reason: "No amount", raw })
      continue
    }
    if (m.invert) amount = -amount

    const description = [row[m.description], m.description2 !== null ? row[m.description2] : ""]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")

    parsed.push({
      line,
      date,
      description: description || "(no description)",
      amount: Math.round(amount * 100) / 100,
    })
  }

  return { parsed, skipped }
}

export type StatementInfo = {
  account: string | null
  accountName: string | null
  from: string | null
  to: string | null
}

function parseLooseDate(value: string): string | null {
  for (const fmt of ["yyyyMMdd", ...DATE_FORMATS]) {
    const d = parseDate(value, fmt)
    if (d) return d
  }
  return null
}

/** Account number and statement period from the preamble lines above the header row. */
export function detectStatementInfo(rows: string[][], headerRow: number): StatementInfo {
  const info: StatementInfo = { account: null, accountName: null, from: null, to: null }
  for (const row of rows.slice(0, headerRow)) {
    const line = row.map((c) => c.trim()).filter(Boolean).join(" ")
    if (!line) continue

    // NZ style: "Bank 12; Branch 3077; Account 0049746-00 (ORBIT Home Loan)"
    const nz = line.match(/bank\s+(\d+);?\s*branch\s+(\d+);?\s*account\s+([\d-]+)(?:\s*\((.+?)\))?/i)
    if (nz && !info.account) {
      info.account = `${nz[1]}-${nz[2]}-${nz[3]}`
      info.accountName = nz[4] ?? null
    } else if (!info.account && /card\s*(?:number|no\.?)/i.test(line)) {
      // "Card Number XXXX-XXXX-XXXX-2699 (Visa Light)"
      const card = line.match(/card\s*(?:number|no\.?)\s*[:;]?\s*([\dX*][\dX*\s-]{6,}\d{4})(?:\s*\((.+?)\))?/i)
      if (card) {
        info.account = card[1].trim()
        info.accountName = card[2] ?? null
      }
    } else if (!info.account) {
      const acct = line.match(
        /account\s*(?:number|no\.?|#)?\s*[:;]?\s*([\dX*][\dX*\s-]{4,}[\dX*])(?:\s*\((.+?)\))?/i
      )
      if (acct) {
        info.account = acct[1].trim()
        info.accountName = acct[2] ?? null
      }
    }

    const range = line.match(/(?:period|statement)\b.*?:?\s*(\S+(?:\s\w+\s\d{2,4})?)\s+(?:to|-|–)\s+(\S+(?:\s\w+\s\d{2,4})?)/i)
    if (range) {
      info.from ??= parseLooseDate(range[1])
      info.to ??= parseLooseDate(range[2])
    }
    const from = line.match(/^(?:from|start)(?:\s*date)?\s*[:;]?\s*(.+)$/i)
    if (from) info.from ??= parseLooseDate(from[1])
    const to = line.match(/^(?:to|end)(?:\s*date)?\s*[:;]?\s*(.+)$/i)
    if (to) info.to ??= parseLooseDate(to[1])
  }
  return info
}
