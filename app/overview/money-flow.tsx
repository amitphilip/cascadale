"use client"

import { useEffect, useRef, useState } from "react"

import { formatMoney, type MoneyFormat } from "@/lib/format"
import type { FlowKind, FlowNode, MonthFlow } from "@/lib/month-figures"
import { cn } from "@/lib/utils"

type Basis = "end" | "soFar"

/** Money in is green, spending blue, savings a neutral: the same three on every node and ribbon. */
const TONE: Record<FlowKind, { fill: string; label: string }> = {
  income: { fill: "var(--chart-1)", label: "Money in" },
  due: { fill: "var(--chart-1)", label: "Money in" },
  from_savings: { fill: "var(--muted-foreground)", label: "Savings" },
  bills: { fill: "var(--chart-2)", label: "Spending" },
  everyday: { fill: "var(--chart-2)", label: "Spending" },
  one_offs: { fill: "var(--chart-2)", label: "Spending" },
  left_over: { fill: "var(--muted-foreground)", label: "Savings" },
}

const NOTE: Partial<Record<FlowKind, string>> = {
  due: "Expected before the month ends, not landed yet.",
  from_savings: "More is going out than coming in, so the gap comes out of what's already in your accounts.",
  left_over: "More is coming in than going out, so this stays in your accounts.",
}

const NODE_W = 10
const POOL_W = 12
const GAP = 8
/** room for a label's two lines */
const LABEL_H = 32
const PARTS_SHOWN = 5

type Placed = FlowNode & { key: string; y: number; h: number; poolY: number; labelY: number }

/** The month's money as a flow: income (and savings) in on the left, through the month, out to bills, everyday and one-offs. */
export function MoneyFlow({ flow, fmt }: { flow: { soFar: MonthFlow; byMonthEnd: MonthFlow }; fmt: MoneyFormat }) {
  const [basis, setBasis] = useState<Basis>("end")
  const data = basis === "end" ? flow.byMonthEnd : flow.soFar
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<{ key: string; x: number; y: number } | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const money = (n: number) => formatMoney(Math.round(n), fmt)
  const rows = Math.max(data.sources.length, data.uses.length, 1)
  const height = Math.min(420, Math.max(220, rows * 56))

  const layout = (() => {
    if (data.total <= 0) return null
    const k = (height - (rows - 1) * GAP) / data.total
    const poolH = data.total * k
    const poolTop = (height - poolH) / 2
    const place = (nodes: FlowNode[], side: "l" | "r"): Placed[] => {
      const hs = nodes.map((n) => Math.max(2, n.amount * k))
      const colH = hs.reduce((s, h) => s + h, 0) + (nodes.length - 1) * GAP
      let y = (height - colH) / 2
      let poolY = poolTop
      const placed = nodes.map((n, i) => {
        const p = { ...n, key: `${side}:${n.kind}:${i}`, y, h: hs[i], poolY, labelY: y + hs[i] / 2 }
        y += hs[i] + GAP
        poolY += n.amount * k
        return p
      })
      // keep labels apart: push down from the top, then back up from the bottom
      for (let i = 1; i < placed.length; i++) {
        placed[i].labelY = Math.max(placed[i].labelY, placed[i - 1].labelY + LABEL_H)
      }
      let floor = height - LABEL_H / 2
      for (let i = placed.length - 1; i >= 0; i--) {
        placed[i].labelY = Math.min(placed[i].labelY, floor)
        floor = placed[i].labelY - LABEL_H
      }
      placed.forEach((p) => (p.labelY = Math.max(LABEL_H / 2, p.labelY)))
      return placed
    }
    return { k, poolH, poolTop, sources: place(data.sources, "l"), uses: place(data.uses, "r") }
  })()

  const poolX = width / 2 - POOL_W / 2
  const band = (x0: number, y0: number, x1: number, y1: number, h: number) => {
    const xm = (x0 + x1) / 2
    return `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + h} C${xm},${y1 + h} ${xm},${y0 + h} ${x0},${y0 + h} Z`
  }
  // a label has the half of the chart beside its node, less the node and some air
  const maxChars = Math.max(8, Math.floor((width / 2 - NODE_W - 24) / 6.6))
  const clip = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s)

  const all = layout ? [...layout.sources, ...layout.uses] : []
  const shown = active ? all.find((n) => n.key === active.key) : undefined

  const point = (key: string) => (e: React.PointerEvent) => {
    const r = wrap.current?.getBoundingClientRect()
    if (r) setActive({ key, x: e.clientX - r.left, y: e.clientY - r.top })
  }
  const hover = (key: string) => ({
    onPointerEnter: point(key),
    onPointerMove: point(key),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === "mouse" && setActive(null),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation()
      const r = wrap.current?.getBoundingClientRect()
      if (r) setActive((a) => (a?.key === key ? null : { key, x: e.clientX - r.left, y: e.clientY - r.top }))
    },
    style: { cursor: "pointer" },
  })
  const dim = (key: string) => (active ? (active.key === key ? 0.6 : 0.12) : 0.3)

  const legend = [...new Set(data.sources.concat(data.uses).map((n) => n.kind))]
    .map((k) => TONE[k])
    .filter((t, i, ts) => ts.findIndex((x) => x.label === t.label) === i)

  return (
    <section className="grid gap-3" aria-label="Where the month's money comes from and goes">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-pretty text-muted-foreground">
          {basis === "end"
            ? "What's landed and still due, against where spending is heading."
            : "What's landed and gone out so far."}
        </p>
        <div role="radiogroup" aria-label="Show" className="inline-grid grid-cols-2 rounded-xl bg-secondary p-1 text-xs">
          {(
            [
              ["end", "By month end"],
              ["soFar", "So far"],
            ] as const
          ).map(([b, label]) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={basis === b}
              onClick={() => {
                setBasis(b)
                setActive(null)
              }}
              className={cn(
                "min-h-8 rounded-lg px-3 font-medium whitespace-nowrap transition-colors",
                basis === b ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div ref={wrap} className="relative" style={{ height }} onClick={() => setActive(null)} aria-hidden>
        {width > 0 && layout && (
          <svg width={width} height={height} className="block overflow-visible">
            {layout.sources.map((n) => (
              <path
                key={`b${n.key}`}
                d={band(NODE_W, n.y, poolX, n.poolY, n.amount * layout.k)}
                fill={TONE[n.kind].fill}
                fillOpacity={n.kind === "due" ? dim(n.key) * 0.5 : dim(n.key)}
                className="transition-[fill-opacity] duration-150"
                {...hover(n.key)}
              />
            ))}
            {layout.uses.map((n) => (
              <path
                key={`b${n.key}`}
                d={band(poolX + POOL_W, n.poolY, width - NODE_W, n.y, n.amount * layout.k)}
                fill={TONE[n.kind].fill}
                fillOpacity={dim(n.key)}
                className="transition-[fill-opacity] duration-150"
                {...hover(n.key)}
              />
            ))}
            <rect x={poolX} y={layout.poolTop} width={POOL_W} height={layout.poolH} rx={3} fill="var(--foreground)" fillOpacity={0.75} />
            {all.map((n) => {
              const left = n.key.startsWith("l")
              return (
                <rect
                  key={`n${n.key}`}
                  x={left ? 0 : width - NODE_W}
                  y={n.y}
                  width={NODE_W}
                  height={n.h}
                  rx={Math.min(4, n.h / 2)}
                  fill={TONE[n.kind].fill}
                  fillOpacity={n.kind === "due" ? 0.5 : 1}
                  {...hover(n.key)}
                />
              )
            })}
            {all.map((n) => {
              const left = n.key.startsWith("l")
              return (
                <text
                  key={`t${n.key}`}
                  x={left ? NODE_W + 8 : width - NODE_W - 8}
                  y={n.labelY}
                  textAnchor={left ? "start" : "end"}
                  paintOrder="stroke"
                  stroke="var(--card)"
                  strokeWidth={4}
                  strokeLinejoin="round"
                  className="pointer-events-none"
                >
                  <tspan x={left ? NODE_W + 8 : width - NODE_W - 8} dy="-0.2em" className="fill-muted-foreground text-[12px]">
                    {clip(n.name)}
                  </tspan>
                  <tspan x={left ? NODE_W + 8 : width - NODE_W - 8} dy="1.25em" className="fill-foreground text-[13px] font-semibold tabular-nums">
                    {money(n.amount)}
                  </tspan>
                </text>
              )
            })}
          </svg>
        )}
        {width > 0 && !layout && (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">Nothing in or out yet this month.</p>
        )}

        {shown && active && (
          <div
            className="pointer-events-none absolute z-10 grid w-60 gap-1.5 rounded-lg border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-lg"
            style={{
              left: Math.min(Math.max(0, active.x - 120), width - 240),
              top: active.y > height / 2 ? undefined : active.y + 14,
              bottom: active.y > height / 2 ? height - active.y + 14 : undefined,
            }}
          >
            <p className="flex items-center gap-2 font-medium">
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: TONE[shown.kind].fill }} />
              <span className="min-w-0 flex-1 truncate">{shown.name}</span>
              <span className="tabular-nums">{money(shown.amount)}</span>
            </p>
            <p className="text-muted-foreground">
              {Math.round((shown.amount / data.total) * 100)}% of the month&rsquo;s money
              {NOTE[shown.kind] ? `. ${NOTE[shown.kind]}` : "."}
            </p>
            {shown.parts.length > 0 && (
              <ul className="grid gap-0.5 border-t pt-1.5">
                {shown.parts.slice(0, PARTS_SHOWN).map((p, i) => (
                  <li key={`${p.name}:${i}`} className="flex justify-between gap-3">
                    <span className="truncate text-muted-foreground">{p.name}</span>
                    <span className="shrink-0 tabular-nums">{money(p.amount)}</span>
                  </li>
                ))}
                {shown.parts.length > PARTS_SHOWN && (
                  <li className="text-muted-foreground">and {shown.parts.length - PARTS_SHOWN} more</li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {legend.map((t) => (
          <span key={t.label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: t.fill }} />
            {t.label}
          </span>
        ))}
        <span className="ml-auto">Tap a flow for what&rsquo;s in it.</span>
      </div>

      <table className="sr-only">
        <caption>{basis === "end" ? "This month by its end" : "This month so far"}</caption>
        <tbody>
          {data.sources.map((n, i) => (
            <tr key={`s${i}`}>
              <th scope="row">In: {n.name}</th>
              <td>{money(n.amount)}</td>
            </tr>
          ))}
          {data.uses.map((n, i) => (
            <tr key={`u${i}`}>
              <th scope="row">Out: {n.name}</th>
              <td>{money(n.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
