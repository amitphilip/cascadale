import Link from "next/link"
import { UserIcon, UsersThreeIcon } from "@phosphor-icons/react/ssr"

import { cn } from "@/lib/utils"
import type { HomeView } from "@/lib/views"

/** My view or the family's, as links that keep the page's other settings. */
export function ViewSwitch({
  view,
  me,
  params,
}: {
  view: HomeView
  /** the signed-in person's name */
  me: string
  /** the page's other search params, kept on switching */
  params: Record<string, string | undefined>
}) {
  const href = (v: HomeView) => {
    const next = new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => !!e[1] && e[0] !== "view")
    )
    next.set("view", v)
    return `/overview?${next}`
  }
  const items = [
    { view: "me", label: me, Icon: UserIcon },
    { view: "family", label: "Family", Icon: UsersThreeIcon },
  ] as const
  return (
    <nav
      aria-label="Whose money"
      className="grid w-full grid-cols-2 rounded-xl bg-secondary p-1 text-sm sm:inline-grid sm:w-auto"
    >
      {items.map((item) => (
        <Link
          key={item.view}
          href={href(item.view)}
          aria-current={view === item.view ? "page" : undefined}
          className={cn(
            "flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-4 font-medium transition-colors",
            view === item.view
              ? "bg-card text-foreground shadow-card"
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
