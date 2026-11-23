"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { inSection, NAV } from "@/lib/nav"
import { cn } from "@/lib/utils"

/** Phone navigation: Home, Plan, Money and Settings. Hidden from md up. */
export function MobileTabBar({ uncategorized }: { uncategorized: number }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80 md:hidden"
    >
      {NAV.map((tab) => {
        const active = inSection(tab, pathname)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
              active ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <span className="relative">
              <tab.icon className="size-6" weight={active ? "fill" : "regular"} aria-hidden />
              {tab.href === "/money" && uncategorized > 0 && (
                <span
                  className="absolute -top-1 left-3.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums"
                  title="Uncategorized transactions"
                >
                  {uncategorized > 99 ? "99+" : uncategorized}
                </span>
              )}
            </span>
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
