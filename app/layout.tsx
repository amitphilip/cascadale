import type { Metadata, Viewport } from "next"
import { Geist_Mono, IBM_Plex_Sans, Source_Sans_3 } from "next/font/google"

import "./globals.css"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getDb } from "@/lib/db"
import { getUncategorizedCount } from "@/lib/queries"
import { cn } from "@/lib/utils"

const sourceSans3Heading = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-heading",
})

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  title: { default: "The Goal", template: "%s · The Goal" },
  description: "Personal finance analysis",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // proxy.ts sends anyone signed out to /sign-in, which renders without the sidebar.
  const { data } = await (await getDb()).auth.getClaims()
  const user = data?.claims ?? null
  const uncategorized = user ? await getUncategorizedCount() : 0

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        ibmPlexSans.variable,
        sourceSans3Heading.variable
      )}
    >
      <body suppressHydrationWarning>
        <ThemeProvider>
          <TooltipProvider>
            {user ? (
              <SidebarProvider>
                <AppSidebar
                  uncategorized={uncategorized}
                  email={user.email ?? null}
                />
                <SidebarInset className="min-w-0">
                  <header className="sticky top-0 z-20 flex min-h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur supports-backdrop-filter:bg-background/80 md:hidden">
                    <SidebarTrigger className="size-11" />
                    <span className="font-heading font-semibold">The Goal</span>
                  </header>
                  <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-6 px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-4 md:p-8">
                    {children}
                  </div>
                </SidebarInset>
              </SidebarProvider>
            ) : (
              children
            )}
            <Toaster richColors={false} />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
