"use client"

import { useEffect, useRef } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { activeTab, MONEY_TABS, PLAN_TABS, SETTINGS_TABS } from "@/lib/nav"
import { cn } from "@/lib/utils"

const SECTIONS = {
  plan: { label: "Plan", tabs: PLAN_TABS },
  money: { label: "Money", tabs: MONEY_TABS },
  settings: { label: "Settings", tabs: SETTINGS_TABS },
}

/**
 * The tab strip at the top of a section (Plan, Money or Settings). On a phone it scrolls
 * sideways within itself, and keeps the open tab in view.
 */
export function SectionTabs({
  section,
  badges,
}: {
  section: keyof typeof SECTIONS
  /** a count to show on a tab, by its href */
  badges?: Record<string, number>
}) {
  const pathname = usePathname()
  const { label, tabs } = SECTIONS[section]
  const active = activeTab(tabs, pathname)
  const activeRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])

  return (
    <nav
      aria-label={label}
      className="-mx-3 -mt-1 overflow-x-auto border-b px-3 [scrollbar-width:none] sm:-mx-4 sm:px-4 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex w-max min-w-full gap-1">
        {tabs.map((tab) => {
          const current = tab.href === active
          const count = badges?.[tab.href] ?? 0
          return (
            <li key={tab.href}>
              <Link
                ref={current ? activeRef : undefined}
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm whitespace-nowrap transition-colors",
                  current
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
                {count > 0 && (
                  <span className="min-w-5 rounded-full bg-muted px-1.5 text-center text-xs leading-5 font-medium tabular-nums">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
