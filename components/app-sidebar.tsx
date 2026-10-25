"use client"

import { useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  ArrowsClockwiseIcon,
  BankIcon,
  ChartPieSliceIcon,
  ScalesIcon,
  GearSixIcon,
  SignOutIcon,
  ListBulletsIcon,
  PiggyBankIcon,
  SparkleIcon,
  TagIcon,
  TargetIcon,
  TrendUpIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
  SidebarRail,
} from "@/components/ui/sidebar"
import { signOut } from "@/app/actions"
import { useServerAction } from "@/hooks/use-server-action"

const NAV = [
  { href: "/", label: "Overview", icon: ChartPieSliceIcon },
  { href: "/statement", label: "Statement", icon: ScalesIcon },
  { href: "/income", label: "Income", icon: TrendUpIcon },
  { href: "/recurring", label: "Recurring & budget", icon: ArrowsClockwiseIcon },
  { href: "/plan", label: "Plan", icon: PiggyBankIcon },
  { href: "/transactions", label: "Transactions", icon: ListBulletsIcon },
  { href: "/accounts", label: "Accounts", icon: BankIcon },
  { href: "/import", label: "Import statements", icon: UploadSimpleIcon },
  { href: "/categories", label: "Categories & rules", icon: TagIcon },
  { href: "/review", label: "Review categories", icon: SparkleIcon },
]

export function AppSidebar({
  uncategorized,
  email,
}: {
  uncategorized: number
  email: string | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { setOpenMobile } = useSidebar()
  const { pending, execute } = useServerAction()
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href)

  // close the mobile drawer after navigating
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" onClick={() => setOpenMobile(false)} />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <TargetIcon weight="bold" className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-heading font-semibold">The Goal</span>
                <span className="truncate text-xs text-muted-foreground">Personal finances</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={isActive(item.href)}
                    tooltip={item.label}
                    render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                  {item.href === "/transactions" && uncategorized > 0 && (
                    <SidebarMenuBadge title="Uncategorized transactions">
                      {uncategorized}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={isActive("/settings")}
              tooltip="Settings"
              render={<Link href="/settings" onClick={() => setOpenMobile(false)} />}
            >
              <GearSixIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={email ? `Sign out ${email}` : "Sign out"}
              disabled={pending}
              onClick={() =>
                execute(() => signOut(), {
                  onSuccess: () => {
                    router.replace("/sign-in")
                    router.refresh()
                  },
                })
              }
            >
              <SignOutIcon />
              <span className="truncate">Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
