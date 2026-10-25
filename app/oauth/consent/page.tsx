import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { ConsentForm } from "./consent-form"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getDb } from "@/lib/db"

export const metadata: Metadata = { title: "Connect an app" }

/**
 * Where Supabase's OAuth server sends you when an app (e.g. claude.ai's MCP connector) asks to
 * act as you. proxy.ts has you sign in first, then returns here.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>
}) {
  const { authorization_id: id } = await searchParams
  const { data, error } = id
    ? await (await getDb()).auth.oauth.getAuthorizationDetails(id)
    : { data: null, error: null }
  // Already approved earlier: go straight back to the app.
  if (data && "redirect_url" in data) redirect(data.redirect_url)

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        {data ? (
          <>
            <CardHeader>
              <CardTitle className="font-heading text-xl">
                Connect {data.client.name || "this app"}?
              </CardTitle>
              <CardDescription>
                It will be able to see everything in The Goal (accounts, transactions, bank
                feeds, budgets and plans) and act on it as {data.user.email}: sync feeds,
                categorize transactions, set budgets and add upcoming expenses.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <p className="text-sm break-all text-muted-foreground">
                You&apos;ll be sent back to {data.redirect_uri}
              </p>
              <ConsentForm authorizationId={data.authorization_id} />
            </CardContent>
          </>
        ) : (
          <CardHeader>
            <CardTitle className="font-heading text-xl">Can&apos;t connect</CardTitle>
            <CardDescription>
              {error?.message ??
                "This link is missing its authorization request. Start connecting again from the app."}
            </CardDescription>
          </CardHeader>
        )}
      </Card>
    </div>
  )
}
