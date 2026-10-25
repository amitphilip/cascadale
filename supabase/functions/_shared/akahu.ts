// Akahu personal app (https://developers.akahu.nz/docs/personal-apps): your own bank
// accounts, read with the two tokens from my.akahu.nz → Developers. Akahu refreshes
// from the banks once a day; syncing reads what it has.
//
// Shared by the Next.js app (lib/akahu.ts) and the akahu-sync edge function, so it
// imports nothing.

const BASE_URL = "https://api.akahu.io/v1"

export type AkahuTokens = { appToken: string; userToken: string }

export type AkahuAccount = {
  _id: string
  _migrated?: string
  name: string
  type: string
  formatted_account?: string
  status: "ACTIVE" | "INACTIVE"
  attributes: string[]
  balance?: { currency: string; current: number; available?: number }
  connection: { name: string; logo?: string }
  refreshed?: { transactions?: string }
}

export type AkahuTransaction = {
  _id: string
  _account: string
  _migrated?: string
  date: string
  description: string
  amount: number
}

/**
 * Setting holding a JSON array of Akahu account ids you chose not to sync, so the sync
 * doesn't add an account for them.
 */
export const AKAHU_IGNORED_SETTING = "akahuIgnored"

const TYPES: Record<string, "checking" | "savings" | "credit_card" | "investment" | "loan"> = {
  CHECKING: "checking",
  SAVINGS: "savings",
  CREDITCARD: "credit_card",
  LOAN: "loan",
  KIWISAVER: "investment",
  INVESTMENT: "investment",
  TERMDEPOSIT: "investment",
}

/** The app's account type (ACCOUNT_TYPES in lib/db/schema.ts) for an Akahu one. */
export function accountType(akahuType: string) {
  return TYPES[akahuType] ?? "other"
}

/**
 * A comparable key for an account number, or null: NZ bank accounts ignoring leading
 * zeros ("12-3077-0049746-00" and "12-3077-49746-000" agree), cards by their last four
 * digits (Akahu and statements both mask the rest).
 */
export function accountNumberKey(value: string | null | undefined) {
  if (!value) return null
  // separators required, so a run of digits (a timestamp in a file name) doesn't match
  const nz = value.match(/(?<!\d)(\d{2})[\s-](\d{4})[\s-](\d{5,8})[\s-](\d{2,3})(?!\d)/)
  if (nz) return nz.slice(1).map(Number).join("-")
  const card = value.match(/[x*•]{4}[\s-]?.*?(\d{4})\s*$/i)
  return card ? `card-${card[1]}` : null
}

export function akahuApi(tokens: AkahuTokens) {
  async function get<T>(path: string, query: Record<string, string | undefined> = {}) {
    const url = new URL(BASE_URL + path)
    for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokens.userToken}`,
        "X-Akahu-Id": tokens.appToken,
      },
      cache: "no-store",
    })
    const body = await res.json().catch(() => null)
    if (res.status === 401 || res.status === 403) {
      throw new Error("Akahu rejected your tokens. Check them in Settings.")
    }
    if (!res.ok || !body?.success) {
      throw new Error(`Akahu: ${body?.message ?? `request failed (${res.status})`}`)
    }
    return body as T
  }

  return {
    async accounts() {
      return (await get<{ items: AkahuAccount[] }>("/accounts")).items
    },
    /** Settled transactions after `start` (exclusive) up to `end` (inclusive), every page. */
    async transactions(accountId: string, start?: string, end?: string) {
      const out: AkahuTransaction[] = []
      let cursor: string | undefined
      do {
        const page = await get<{ items: AkahuTransaction[]; cursor?: { next?: string | null } }>(
          `/accounts/${encodeURIComponent(accountId)}/transactions`,
          { start, end, cursor }
        )
        out.push(...page.items)
        // cursor.next is null after the last page
        cursor = page.items.length > 0 ? (page.cursor?.next ?? undefined) : undefined
      } while (cursor)
      return out
    },
  }
}

export type AkahuApi = ReturnType<typeof akahuApi>

// Akahu only covers New Zealand banks; a transaction's day is its day in New Zealand.
const nzDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Pacific/Auckland",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export function localDate(iso: string) {
  return nzDate.format(new Date(iso))
}

/** Midnight UTC `days` before a YYYY-MM-DD date, as an ISO timestamp. */
export function daysBefore(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString()
}
