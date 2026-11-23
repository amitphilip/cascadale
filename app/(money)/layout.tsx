import { SectionTabs } from "@/components/section-tabs"
import { getUncategorizedCount } from "@/lib/queries"

/** Money: the detail behind Home, one tab per view of it. */
export default async function MoneyLayout({ children }: { children: React.ReactNode }) {
  const uncategorized = await getUncategorizedCount()
  return (
    <>
      <SectionTabs section="money" badges={{ "/transactions": uncategorized }} />
      {children}
    </>
  )
}
