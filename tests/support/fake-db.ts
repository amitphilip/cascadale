// A small in-memory stand-in for the Supabase client, enough for the planning tools' writes:
// from(table).select/insert/update/delete/upsert with eq, is, in, gte, order, limit, single
// and maybeSingle. Selects take the app's "alias:column" lists.

type Row = Record<string, unknown>

function project(row: Row, columns: string | undefined) {
  if (!columns || columns.trim() === "*") return { ...row }
  const out: Row = {}
  for (const part of columns.split(",").map((c) => c.trim()).filter(Boolean)) {
    const [alias, column] = part.includes(":") ? part.split(":").map((x) => x.trim()) : [part, part]
    out[alias] = row[column] ?? null
  }
  return out
}

export function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  const ids = new Map<string, number>()
  const writes: { table: string; op: string; row: Row }[] = []
  const rows = (t: string) => {
    if (!tables.has(t)) tables.set(t, [])
    return tables.get(t)!
  }

  function from(table: string) {
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select"
    let payload: Row | Row[] | null = null
    let columns: string | undefined
    let one: "single" | "maybe" | null = null
    let limit: number | null = null
    const filters: ((r: Row) => boolean)[] = []
    const orders: { col: string; asc: boolean }[] = []

    const run = () => {
      const all = rows(table)
      let result: Row[] = []
      if (op === "insert" || op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload!]
        for (const p of list) {
          const next = (ids.get(table) ?? Math.max(0, ...all.map((r) => Number(r.id) || 0))) + 1
          ids.set(table, next)
          const row: Row = { id: next, created_at: new Date().toISOString(), status: table === "pending_plan_changes" ? "pending" : undefined, ...p }
          all.push(row)
          writes.push({ table, op, row })
          result.push(row)
        }
      } else {
        result = all.filter((r) => filters.every((f) => f(r)))
        if (op === "update") {
          for (const r of result) {
            Object.assign(r, payload)
            writes.push({ table, op, row: r })
          }
        }
        if (op === "delete") {
          tables.set(table, all.filter((r) => !result.includes(r)))
          result.forEach((r) => writes.push({ table, op, row: r }))
        }
      }
      for (const o of [...orders].reverse()) {
        result = [...result].sort((a, b) => (a[o.col]! > b[o.col]! ? 1 : a[o.col]! < b[o.col]! ? -1 : 0) * (o.asc ? 1 : -1))
      }
      if (limit !== null) result = result.slice(0, limit)
      const data = result.map((r) => project(r, columns))
      if (one === "single") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `expected one row, got ${data.length}`, code: "PGRST116" } }
      if (one === "maybe") return { data: data[0] ?? null, error: null }
      return { data, error: null }
    }

    const q = {
      select(c?: string) {
        columns = c
        return q
      },
      insert(p: Row | Row[]) {
        op = "insert"
        payload = p
        return q
      },
      upsert(p: Row | Row[]) {
        op = "upsert"
        payload = p
        return q
      },
      update(p: Row) {
        op = "update"
        payload = p
        return q
      },
      delete() {
        op = "delete"
        return q
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v)
        return q
      },
      is(col: string, v: unknown) {
        filters.push((r) => (r[col] ?? null) === v)
        return q
      },
      in(col: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[col]))
        return q
      },
      gte(col: string, v: string) {
        filters.push((r) => String(r[col]) >= v)
        return q
      },
      order(col: string, o?: { ascending?: boolean }) {
        orders.push({ col, asc: o?.ascending ?? true })
        return q
      },
      limit(n: number) {
        limit = n
        return q
      },
      single() {
        one = "single"
        return q
      },
      maybeSingle() {
        one = "maybe"
        return q
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
        try {
          return Promise.resolve(resolve(run()))
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e)
        }
      },
    }
    return q
  }

  return { client: { from }, tables, writes, rows }
}
