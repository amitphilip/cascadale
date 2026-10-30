import { afterEach, describe, expect, it, vi } from "vitest"

import { todayLocal } from "@/supabase/functions/_shared/akahu"

const at = (iso: string) => todayLocal(new Date(iso))

describe("todayLocal", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("is New Zealand's date on a morning that's still yesterday in UTC", () => {
    expect(at("2026-10-30T23:22:00Z")).toBe("2026-10-31")
  })

  it("reads the clock when none is passed", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-30T23:22:00Z"))
    expect(todayLocal()).toBe("2026-10-31")
  })

  it("rolls the month and year over with New Zealand", () => {
    expect(at("2026-10-31T10:59:00Z").slice(0, 7)).toBe("2026-10")
    expect(at("2026-10-31T11:00:00Z").slice(0, 7)).toBe("2026-11")
    expect(at("2026-12-31T11:00:00Z")).toBe("2027-01-01")
  })

  // NZDT (UTC+13) ends at 3am on Sunday 5 April 2026, 14:00 UTC on the 4th
  it("moves midnight from 11:00 to 12:00 UTC when daylight saving ends", () => {
    expect(at("2026-04-04T10:59:00Z")).toBe("2026-04-04")
    expect(at("2026-04-04T11:00:00Z")).toBe("2026-04-05")
    expect(at("2026-04-04T13:59:00Z")).toBe("2026-04-05")
    expect(at("2026-04-04T14:01:00Z")).toBe("2026-04-05")
    expect(at("2026-04-05T11:30:00Z")).toBe("2026-04-05")
    expect(at("2026-04-05T12:00:00Z")).toBe("2026-04-06")
  })

  // NZDT starts at 2am on Sunday 27 September 2026, 14:00 UTC on the 26th
  it("moves midnight from 12:00 to 11:00 UTC when daylight saving starts", () => {
    expect(at("2026-09-26T11:30:00Z")).toBe("2026-09-26")
    expect(at("2026-09-26T12:00:00Z")).toBe("2026-09-27")
    expect(at("2026-09-26T13:59:00Z")).toBe("2026-09-27")
    expect(at("2026-09-26T14:01:00Z")).toBe("2026-09-27")
    expect(at("2026-09-27T10:59:00Z")).toBe("2026-09-27")
    expect(at("2026-09-27T11:00:00Z")).toBe("2026-09-28")
  })
})
