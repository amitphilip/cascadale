import Link from "next/link"
import {
  BriefcaseIcon,
  UserIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react/ssr"

import { cn } from "@/lib/utils"
import type { View } from "@/lib/views"

/** Me, Family or Accountant: the same plan for one person, the household, or its books. */
export function ViewSwitcher({ view, me }: { view: View; me: string }) {
  const items = [
    { view: "me", label: me, Icon: UserIcon },
    { view: "family", label: "Family", Icon: UsersThreeIcon },
    { view: "accountant", label: "Accountant", Icon: BriefcaseIcon },
  ] as const
  return (
    <nav
      aria-label="View"
      className="inline-flex max-w-full rounded-lg border bg-muted/50 p-0.5 text-sm"
    >
      {items.map((item) => (
        <Link
          key={item.view}
          href={`/plan?view=${item.view}`}
          aria-current={view === item.view ? "page" : undefined}
          className={cn(
            "flex min-h-9 min-w-0 items-center gap-1.5 rounded-md px-3 font-medium",
            view === item.view
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <item.Icon className="shrink-0" />
          <span className="truncate">{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
