/**
 * Finding an account by what people call it: its name, one of its aliases, or what it's for
 * (its purpose), e.g. "the rates account" or "Tax". A single clear winner is the match; when
 * it isn't clear, the candidates come back so the caller can ask. Pure functions.
 */

export type AccountRef = {
  id: number
  name: string
  aliases?: string[] | null
  purpose?: string | null
  archived?: boolean
}

export type AccountCandidate = {
  id: number
  name: string
  aliases: string[]
  purpose: string | null
  score: number
  matchedOn: "name" | "alias" | "purpose"
}

const FILLER = new Set(["the", "my", "our", "a", "an", "account", "acct", "a/c"])

/** Lower case, punctuation gone, filler words ("the", "account") dropped. */
export function normalise(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .join(" ")
}

const words = (s: string) => new Set(normalise(s).split(" ").filter(Boolean))
const allIn = (needle: Set<string>, hay: Set<string>) => needle.size > 0 && [...needle].every((w) => hay.has(w))

function score(a: AccountRef, query: string): Pick<AccountCandidate, "score" | "matchedOn"> | null {
  const q = normalise(query)
  if (!q) return null
  const qWords = words(query)
  const name = normalise(a.name)
  const aliases = (a.aliases ?? []).map(normalise)
  if (name === q) return { score: 100, matchedOn: "name" }
  if (aliases.includes(q)) return { score: 95, matchedOn: "alias" }
  if (allIn(qWords, words(a.name))) return { score: 70, matchedOn: "name" }
  if (aliases.some((al) => allIn(qWords, words(al)) || allIn(words(al), qWords))) return { score: 65, matchedOn: "alias" }
  if (a.purpose && allIn(qWords, words(a.purpose))) return { score: 60, matchedOn: "purpose" }
  const overlap = [...qWords].filter((w) => words(a.name).has(w) || (a.purpose && words(a.purpose).has(w))).length
  if (overlap) return { score: 20 + overlap * 5, matchedOn: words(a.name).has([...qWords][0]) ? "name" : "purpose" }
  return null
}

/** The account a phrase means, or the candidates when it isn't clear. Archived accounts are left out. */
export function findAccount(accounts: AccountRef[], query: string) {
  const candidates = accounts
    .filter((a) => !a.archived)
    .flatMap((a): AccountCandidate[] => {
      const s = score(a, query)
      return s ? [{ id: a.id, name: a.name, aliases: a.aliases ?? [], purpose: a.purpose ?? null, ...s }] : []
    })
    .sort((x, y) => y.score - x.score || x.id - y.id)
  const [top, next] = candidates
  // an exact name or alias wins outright; otherwise it has to be the only strong candidate
  const clear = top && top.score >= 60 && (top.score >= 95 ? next?.score !== top.score : !next || next.score < 60)
  return { match: clear ? top : null, candidates }
}

/** The id an account phrase means, or an error naming the candidates. */
export function resolveAccountId(accounts: AccountRef[], query: string, what = "Account") {
  const { match, candidates } = findAccount(accounts, query)
  if (match) return match.id
  const list = (candidates.length ? candidates : accounts.filter((a) => !a.archived))
    .slice(0, 6)
    .map((a) => `${a.id} ${a.name}`)
    .join(", ")
  throw new Error(
    `${what}: ${candidates.length ? `"${query}" could be several accounts` : `no account matches "${query}"`}. Pass an id: ${list}`
  )
}
