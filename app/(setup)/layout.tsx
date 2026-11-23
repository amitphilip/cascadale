import { SectionTabs } from "@/components/section-tabs"

/** Settings: everything that's setup, one tab per part of it. */
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionTabs section="settings" />
      {children}
    </>
  )
}
