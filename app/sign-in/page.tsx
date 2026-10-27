import type { Metadata } from "next"

import { SignInForm } from "./sign-in-form"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { LogoMark } from "@/components/logo"

export const metadata: Metadata = { title: "Sign in" }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams
  // Only return to paths on this site.
  const to = next?.startsWith("/") && !next.startsWith("//") ? next : "/"
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-heading text-xl">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <LogoMark className="size-5" />
            </span>
            Cascadale
          </CardTitle>
          <CardDescription>
            {error === "link"
              ? "That reset link is invalid or has expired. Request a new one below."
              : "Sign in to see your finances."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm next={to} />
        </CardContent>
      </Card>
    </div>
  )
}
