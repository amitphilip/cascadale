import { cn } from "@/lib/utils"

export type MeterTone = "positive" | "warning" | "destructive" | "primary"

const FILL: Record<MeterTone, string> = {
  primary: "bg-primary",
  positive: "bg-positive",
  warning: "bg-warning",
  destructive: "bg-destructive",
}

/**
 * A slim bar of how much of something is used. `mark` ticks where it should be by now
 * (an even pace through the period), so running ahead shows at a glance.
 */
export function Meter({
  value,
  max,
  mark,
  tone = "primary",
  className,
  label,
}: {
  value: number
  max: number
  /** 0 to 1: where an even pace would be */
  mark?: number
  tone?: MeterTone
  className?: string
  /** read out in place of the bar */
  label: string
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.max(0, Math.min(value, max))}
      className={cn("relative h-1.5 w-full rounded-full bg-foreground/8", className)}
    >
      <div className={cn("h-full rounded-full", FILL[tone])} style={{ width: `${share * 100}%` }} />
      {mark !== undefined && mark > 0 && mark < 1 && (
        <span
          aria-hidden
          className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/35 ring-2 ring-card"
          style={{ left: `${mark * 100}%` }}
        />
      )}
    </div>
  )
}
