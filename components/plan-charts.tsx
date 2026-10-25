"use client"

import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"

import { useIsMobile } from "@/hooks/use-mobile"

import { moneyTooltipRow } from "@/components/charts"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatMoney, type MoneyFormat } from "@/lib/format"

export type Series = { key: string; label: string; color: string; values: number[] }

const shortDate = (iso: string, locale: string) => {
  const [y, m, d] = iso.split("-").map(Number)
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(
    new Date(y, m - 1, d)
  )
}

/** Day-by-day lines over the plan horizon, with zero marked. */
export function TimelineChart({
  days,
  series,
  fmt,
  step = false,
}: {
  days: string[]
  series: Series[]
  fmt: MoneyFormat
  /** money that moves in jumps (pots) rather than day to day */
  step?: boolean
}) {
  const config = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }])
  ) satisfies ChartConfig
  const data = days.map((day, i) => ({
    day,
    ...Object.fromEntries(series.map((s) => [s.key, s.values[i]])),
  }))
  const mobile = useIsMobile()
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full sm:h-72">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={mobile ? 48 : 32}
          tickFormatter={(d: string) => shortDate(d, fmt.locale)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={mobile ? 44 : 64}
          tickFormatter={(v: number) => formatMoney(v, fmt, { compact: true })}
        />
        <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) =>
                shortDate(String(payload?.[0]?.payload?.day ?? ""), fmt.locale)
              }
              formatter={moneyTooltipRow(fmt, config)}
            />
          }
        />
        {!mobile && (
          <ChartLegend
            content={<ChartLegendContent className="flex-wrap gap-x-3 gap-y-1" />}
            itemSorter={null}
          />
        )}
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type={step ? "stepAfter" : "linear"}
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
