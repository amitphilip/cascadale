import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google"

import "./globals.css"
import { AppSidebar } from "@/components/app-sidebar"
import { LogoMark } from "@/components/logo"
import { MobileTabBar } from "@/components/mobile-tab-bar"
import { ServiceWorker } from "@/components/service-worker"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getDb } from "@/lib/db"
import { getUncategorizedCount } from "@/lib/queries"
import { cn } from "@/lib/utils"

// A serif for titles and the big numbers, a clean sans for everything else.
const fontHeading = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-heading",
  axes: ["opsz"],
})

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export const metadata: Metadata = {
  title: { default: "Cascadale", template: "%s · Cascadale" },
  description: "Personal finance analysis",
  applicationName: "Cascadale",
  appleWebApp: {
    capable: true,
    title: "Cascadale",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#111513" },
  ],
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
        fontSans.variable,
        fontHeading.variable
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
                <SidebarInset className="min-w-0 bg-background">
                  <header className="sticky top-0 z-20 flex min-h-12 shrink-0 items-center gap-2 border-b bg-background/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur supports-backdrop-filter:bg-background/75 md:hidden">
                    <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <LogoMark className="size-4" />
                    </span>
                    <span className="font-heading text-lg font-semibold">Cascadale</span>
                  </header>
                  <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-1 flex-col gap-6 px-3 py-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:p-4 sm:pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-10 md:py-9">
                    {children}
                  </div>
                </SidebarInset>
                <MobileTabBar uncategorized={uncategorized} />
              </SidebarProvider>
            ) : (
              children
            )}
            <Toaster richColors={false} mobileOffset={{ bottom: "5rem" }} />
            <ServiceWorker />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
