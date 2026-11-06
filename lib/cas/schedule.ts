/** The events that start a Cas background run. */
export const CAS_TRIGGERS = ["feeds/synced", "plan/changed", "cas/refresh"] as const

/**
 * How long Cas waits after the last event of a burst before it runs, per household: a burst
 * runs it once, 90 seconds after the last event and at most 10 minutes after the first.
 */
export const DEBOUNCE = { key: "event.data.householdId", period: "90s", timeout: "10m" } as const
