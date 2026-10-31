"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  DotsThreeIcon,
  GearSixIcon,
  SignOutIcon,
} from "@phosphor-icons/react"

import { signOut } from "@/app/actions"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useServerAction } from "@/hooks/use-server-action"
import { NAV, TAB_HREFS } from "@/lib/nav"
import { cn } from "@/lib/utils"

const TABS = TAB_HREFS.map((href) => NAV.find((n) => n.href === href)!)
const MORE = NAV.filter((n) => !TAB_HREFS.includes(n.href))

const ITEM =
  "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium"

/** Phone navigation: the four most-used pages plus a sheet with the rest. Hidden from md up. */
export function MobileTabBar({
  uncategorized,
  email,
}: {
  uncategorized: number
  email: string | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const { pending, execute } = useServerAction()
  const isActive = (href: string) => pathname.startsWith(href)
  const moreActive = [...MORE.map((n) => n.href), "/settings"].some(isActive)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the sheet after navigating
    setOpen(false)
  }, [pathname])

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80 md:hidden"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive(tab.href) ? "page" : undefined}
            className={cn(
              ITEM,
              isActive(tab.href) ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <span className="relative">
              <tab.icon
                className="size-6"
                weight={isActive(tab.href) ? "fill" : "regular"}
              />
              {tab.href === "/transactions" && uncategorized > 0 && (
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
        ))}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(ITEM, moreActive ? "text-foreground" : "text-muted-foreground")}
        >
          <DotsThreeIcon className="size-6" weight="bold" />
          More
        </button>
      </nav>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <ul className="grid gap-1 px-2">
            {[
              ...MORE,
              { href: "/settings", label: "Settings", icon: GearSixIcon },
            ].map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-lg px-3 text-base",
                    isActive(item.href)
                      ? "bg-accent font-medium"
                      : "active:bg-accent"
                  )}
                >
                  <item.icon className="size-5 text-muted-foreground" />
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  execute(() => signOut(), {
                    onSuccess: () => {
                      router.replace("/sign-in")
                      router.refresh()
                    },
                  })
                }
                className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-base active:bg-accent disabled:opacity-50"
              >
                <SignOutIcon className="size-5 text-muted-foreground" />
                <span className="truncate">
                  Sign out{email ? ` (${email})` : ""}
                </span>
              </button>
            </li>
          </ul>
        </SheetContent>
      </Sheet>
    </>
  )
}
