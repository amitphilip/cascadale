import {
  ArrowsClockwiseIcon,
  BankIcon,
  ChartPieSliceIcon,
  CoinsIcon,
  ListBulletsIcon,
  PiggyBankIcon,
  ScalesIcon,
  SparkleIcon,
  TagIcon,
  TrendUpIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react"

export const NAV = [
  { href: "/overview", label: "Overview", icon: ChartPieSliceIcon },
  { href: "/statement", label: "Statement", icon: ScalesIcon },
  { href: "/income", label: "Income", icon: TrendUpIcon },
  {
    href: "/recurring",
    label: "Recurring & budget",
    icon: ArrowsClockwiseIcon,
  },
  { href: "/plan", label: "Plan", icon: PiggyBankIcon },
  { href: "/transactions", label: "Transactions", icon: ListBulletsIcon },
  { href: "/accounts", label: "Accounts", icon: BankIcon },
  { href: "/net-worth", label: "Net worth", icon: CoinsIcon },
  { href: "/import", label: "Import statements", icon: UploadSimpleIcon },
  { href: "/categories", label: "Categories & rules", icon: TagIcon },
  { href: "/review", label: "Review categories", icon: SparkleIcon },
]

/** Pinned to the bottom bar on phones, in this order; everything else sits under More. */
export const TAB_HREFS = ["/plan", "/overview", "/transactions", "/review"]
