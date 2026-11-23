import {
  GearSixIcon,
  HouseIcon,
  PiggyBankIcon,
  WalletIcon,
} from "@phosphor-icons/react"

/** A tab inside one of the app's sections. */
export type SectionTab = { href: string; label: string }

/** Cas's plan and the budgets it's made of. */
export const PLAN_TABS: SectionTab[] = [
  { href: "/plan", label: "Plan" },
  { href: "/plan/budgets", label: "Budgets" },
]

/** The detail behind Home: where the money went, and what's coming. */
export const MONEY_TABS: SectionTab[] = [
  { href: "/money", label: "Summary" },
  { href: "/transactions", label: "Transactions" },
  { href: "/one-offs", label: "One-offs" },
  { href: "/income", label: "Income" },
  { href: "/statement", label: "Statement" },
  { href: "/net-worth", label: "Net worth" },
]

/** Everything that's setup: you, the accounts and feeds, and how spending is sorted. */
export const SETTINGS_TABS: SectionTab[] = [
  { href: "/settings", label: "General" },
  { href: "/accounts", label: "Accounts" },
  { href: "/import", label: "Import & sync" },
  { href: "/categories", label: "Categories" },
  { href: "/review", label: "Review" },
]

export type NavItem = {
  href: string
  label: string
  icon: typeof HouseIcon
  /** the pages that count as this section */
  tabs: SectionTab[]
}

/** The app's four places, in the sidebar and the phone's tab bar. */
export const NAV: NavItem[] = [
  { href: "/overview", label: "Home", icon: HouseIcon, tabs: [{ href: "/overview", label: "Home" }] },
  { href: "/plan", label: "Plan", icon: PiggyBankIcon, tabs: PLAN_TABS },
  { href: "/money", label: "Money", icon: WalletIcon, tabs: MONEY_TABS },
  { href: "/settings", label: "Settings", icon: GearSixIcon, tabs: SETTINGS_TABS },
]

/** Whether a path is this page or one below it. */
export const isUnder = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`)

/** The tab a path belongs to: the most specific one that contains it. */
export function activeTab(tabs: SectionTab[], pathname: string) {
  return tabs
    .filter((t) => isUnder(pathname, t.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null
}

/** Whether a path is anywhere in this section. */
export const inSection = (item: NavItem, pathname: string) =>
  activeTab(item.tabs, pathname) !== null
