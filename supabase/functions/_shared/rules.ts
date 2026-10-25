// Shared by the Next.js app (re-exported from lib/rules.ts) and the akahu-sync edge
// function, so it imports nothing: Deno and the bundler resolve modules differently.

/** The fields of a rule (lib/db/schema.ts) that matching needs. */
export type RuleLike = {
  id: number
  pattern: string
  categoryId: number
  kind: "contains" | "merchant"
  source: "manual" | "ai" | "learned"
  confidence: number
}

export type RuleMatch = {
  ruleId: number
  categoryId: number
  /** 0–100 */
  confidence: number
  /** What decided the category originally: a user rule or the LLM. */
  source: "rule" | "ai"
}

/** Below this similarity a fuzzy merchant match is ignored. */
export const FUZZY_THRESHOLD = 0.85

// Card-processor / channel prefixes and filler words banks put around the
// merchant name. Removing them makes "POS 1234 SQ *BLUE BOTTLE #22" and
// "SQ *BLUE BOTTLE COFFEE" normalize to the same merchant.
const NOISE = new Set([
  "pos", "purchase", "debit", "credit", "card", "visa", "mastercard", "mc",
  "ach", "recurring", "transaction", "txn", "ref", "upi", "imps", "neft",
  "rtgs", "online", "web", "www", "com", "inc", "llc", "ltd", "co", "the",
  "sq", "tst", "pp", "paypal", "sp", "dd", "fx", "intl", "international",
  "contactless", "chk", "checkcard", "withdrawal", "deposit", "pmt", "pmts",
  "mktp", "mktplace", "us", "usa",
])

/**
 * Reduce a bank description to a stable merchant key: lowercase, drop tokens
 * with digits (dates, store numbers, references) and banking filler, keep the
 * first few meaningful words.
 */
export function merchantKey(description: string): string {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !/\d/.test(t) && !NOISE.has(t))
  const key = tokens.slice(0, 4).join(" ")
  return key || description.toLowerCase().replace(/\s+/g, " ").trim()
}

function bigrams(s: string) {
  const out = new Map<string, number>()
  const t = s.replace(/\s+/g, " ")
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/**
 * Similarity in [0, 1] between two merchant keys: Sørensen–Dice over
 * character bigrams, boosted when one key's words are a prefix of the
 * other's ("starbucks" vs "starbucks seattle").
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length >= 4 && (long + " ").startsWith(short + " ")) return 0.9
  const ga = bigrams(a)
  const gb = bigrams(b)
  let total = 0
  let shared = 0
  for (const n of ga.values()) total += n
  for (const [g, n] of gb) {
    total += n
    shared += Math.min(n, ga.get(g) ?? 0)
  }
  return total === 0 ? 0 : (2 * shared) / total
}

/**
 * Matching order:
 * 1. exact merchant-key rule (learned from you or from the LLM),
 * 2. "description contains" rules you wrote, longest pattern first,
 * 3. fuzzy merchant-key match, confidence scaled by similarity.
 */
export function buildMatcher(rules: RuleLike[]) {
  const merchants = new Map<string, RuleLike>()
  const contains: { needle: string; rule: RuleLike }[] = []
  for (const r of rules) {
    const needle = r.pattern.trim().toLowerCase()
    if (!needle) continue
    if (r.kind === "merchant") merchants.set(needle, r)
    else contains.push({ needle, rule: r })
  }
  contains.sort((a, b) => b.needle.length - a.needle.length)
  const merchantList = [...merchants.values()]

  const toMatch = (r: RuleLike, sim = 1): RuleMatch => ({
    ruleId: r.id,
    categoryId: r.categoryId,
    confidence: Math.round(r.confidence * sim),
    source: r.source === "ai" ? "ai" : "rule",
  })

  return (description: string): RuleMatch | null => {
    const key = merchantKey(description)
    const exact = merchants.get(key)
    if (exact) return toMatch(exact)

    const hay = description.toLowerCase()
    const hit = contains.find((c) => hay.includes(c.needle))
    if (hit) return toMatch(hit.rule)

    let best: RuleLike | null = null
    let bestSim = 0
    for (const r of merchantList) {
      const sim = similarity(key, r.pattern)
      if (sim > bestSim) {
        best = r
        bestSim = sim
      }
    }
    return best && bestSim >= FUZZY_THRESHOLD ? toMatch(best, bestSim) : null
  }
}
