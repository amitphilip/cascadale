"use client"

import { Bar, BarChart, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"

import { useIsMobile } from "@/hooks/use-mobile"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatMoney, type MoneyFormat } from "@/lib/format"

export function moneyTooltipRow(fmt: MoneyFormat, config: ChartConfig) {
  // eslint-disable-next-line react/display-name
  return (value: unknown, name: unknown, item: { color?: string }) => (
    <div className="flex w-full items-center gap-2">
      <span
        className="size-2.5 shrink-0 rounded-[2px]"
        style={{ backgroundColor: item.color }}
      />
      <span className="text-muted-foreground">
        {config[String(name)]?.label ?? String(name)}
      </span>
      <span className="ml-auto font-medium text-foreground tabular-nums">
        {formatMoney(Number(value), fmt)}
      </span>
    </div>
  )
}

const cashflowConfig = {
  income: { label: "Income", color: "var(--chart-1)" },
  expense: { label: "Spending", color: "var(--chart-2)" },
} satisfies ChartConfig

export function CashflowChart({
  data,
  fmt,
}: {
  data: { label: string; income: number; expense: number }[]
  fmt: MoneyFormat
}) {
  const mobile = useIsMobile()
  return (
    <ChartContainer config={cashflowConfig} className="aspect-auto h-64 w-full sm:h-72">
      <BarChart data={data} barGap={2} margin={{ left: 0, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={mobile ? 44 : 64}
          tickFormatter={(v: number) => formatMoney(v, fmt, { compact: true })}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.4 }}
          content={<ChartTooltipContent formatter={moneyTooltipRow(fmt, cashflowConfig)} />}
        />
        {/* keep legend in bar order rather than alphabetical */}
        <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
        <Bar dataKey="income" fill="var(--color-income)" radius={[4, 4, 0, 0]} maxBarSize={28} />
        <Bar dataKey="expense" fill="var(--color-expense)" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ChartContainer>
  )
}

const spendConfig = {
  spent: { label: "Spent", color: "var(--chart-1)" },
} satisfies ChartConfig

export function CategorySpendChart({
  data,
  fmt,
}: {
  data: { name: string; spent: number }[]
  fmt: MoneyFormat
}) {
  const mobile = useIsMobile()
  return (
    <ChartContainer
      config={spendConfig}
      className="aspect-auto w-full"
      style={{ height: Math.max(120, data.length * 36 + 16) }}
    >
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          tickLine={false}
          axisLine={false}
          width={mobile ? 88 : 140}
          tick={{ fontSize: mobile ? 11 : 12 }}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.4 }}
          content={<ChartTooltipContent hideLabel formatter={(v, _n, item) => (
            <div className="flex w-full items-center gap-2">
              <span className="text-muted-foreground">{(item.payload as { name: string }).name}</span>
              <span className="ml-auto font-medium text-foreground tabular-nums">
                {formatMoney(Number(v), fmt)}
              </span>
            </div>
          )} />}
        />
        <Bar dataKey="spent" fill="var(--color-spent)" radius={4} barSize={20} />
      </BarChart>
    </ChartContainer>
  )
}

const incomeConfig = {
  regular: { label: "Regular pay", color: "var(--chart-1)" },
  oneOff: { label: "One-offs", color: "var(--chart-3)" },
  rate: { label: "Regular rate /mo", color: "var(--foreground)" },
} satisfies ChartConfig

/** Income received per month, one-offs stacked on regular pay, with the regular run rate. */
export function IncomeChart({
  data,
  fmt,
}: {
  data: { label: string; regular: number; oneOff: number; rate: number }[]
  fmt: MoneyFormat
}) {
  const mobile = useIsMobile()
  return (
    <ChartContainer config={incomeConfig} className="aspect-auto h-64 w-full sm:h-72">
      <ComposedChart data={data} margin={{ left: 0, right: 4, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={mobile ? 44 : 64}
          tickFormatter={(v: number) => formatMoney(v, fmt, { compact: true })}
        />
        <ChartTooltip
          cursor={{ fillOpacity: 0.4 }}
          content={<ChartTooltipContent formatter={moneyTooltipRow(fmt, incomeConfig)} />}
        />
        <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
        <Bar
          dataKey="regular"
          stackId="income"
          fill="var(--color-regular)"
          stroke="var(--card)"
          strokeWidth={1}
          maxBarSize={28}
        />
        <Bar
          dataKey="oneOff"
          stackId="income"
          fill="var(--color-oneOff)"
          stroke="var(--card)"
          strokeWidth={1}
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
        <Line
          dataKey="rate"
          type="stepAfter"
          stroke="var(--color-rate)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </ComposedChart>
    </ChartContainer>
  )
}
