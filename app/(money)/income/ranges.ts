export const RANGES = { "1y": "1 year", "2y": "2 years", "3y": "3 years", all: "All" } as const
export type Range = keyof typeof RANGES

/**
 * Months of history each range looks back over: one extra, so the latest full month has the
 * same month a year earlier to compare with.
 */
export const RANGE_MONTHS: Record<Range, number> = { "1y": 13, "2y": 25, "3y": 37, all: 1200 }

export function parseRange(value: string | undefined): Range {
  return value && value in RANGES ? (value as Range) : "2y"
}
