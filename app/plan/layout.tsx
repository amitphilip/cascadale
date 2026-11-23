import { SectionTabs } from "@/components/section-tabs"

/** Plan: Cas's plan, and the budgets that are its lines. */
export default function PlanLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionTabs section="plan" />
      {children}
    </>
  )
}
