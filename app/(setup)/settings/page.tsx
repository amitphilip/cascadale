import type { Metadata } from "next"
import { headers } from "next/headers"
import Link from "next/link"

import { AkahuForm } from "./akahu-form"
import { ApiKeyForm } from "./api-key-form"
import { CopyField } from "./copy-field"
import { InstallApp } from "./install-card"
import { PushToggle } from "./push-card"
import { SettingsForm } from "./settings-form"
import { SignOutButton } from "./sign-out-button"
import { YouForm } from "./you-form"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getAkahuStatus } from "@/lib/akahu"
import { MCP_RESOURCES } from "@/lib/mcp"
import { getApiKeyStatus } from "@/lib/anthropic"
import { getDb, getUserId } from "@/lib/db"
import { getMyPrefs, getPeople, getSettings } from "@/lib/queries"

export const metadata: Metadata = { title: "Settings" }

export default async function SettingsPage() {
  const userId = await getUserId()
  const [current, apiKey, akahu, prefs, people, { data: auth }] = await Promise.all([
    getSettings(),
    getApiKeyStatus(),
    getAkahuStatus(),
    getMyPrefs(userId),
    getPeople(),
    getDb().then((db) => db.auth.getClaims()),
  ])
  const email = auth?.claims.email ?? null
  const origin = await siteOrigin()
  return (
    <>
      <PageHeader title="Settings" description="You, how the app looks, and what it's connected to." />
      <Card>
        <CardHeader>
          <CardTitle>You</CardTitle>
          <CardDescription>
            Everyone in the household sees the same money; you choose where
            you start.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <YouForm
            name={prefs.name ?? people.find((p) => p.id === userId)?.name ?? ""}
            homeView={prefs.homeView}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cas messages</CardTitle>
          <CardDescription>
            Cas tells you when your pay lands and what to move, and gives a Monday check-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PushToggle />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Display</CardTitle>
          <CardDescription>
            All accounts are assumed to use this currency.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm current={current} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Install</CardTitle>
          <CardDescription>
            Add Cascadale to your home screen to open it like an app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InstallApp />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>AI</CardTitle>
          <CardDescription>
            Transaction descriptions and summaries are sent to Anthropic when
            you use AI features.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyForm status={apiKey} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bank feeds</CardTitle>
          <CardDescription>
            Sync transactions from your New Zealand bank accounts through an Akahu
            personal app. Link accounts under Import &amp; sync.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AkahuForm status={akahu} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Claude connectors</CardTitle>
          <CardDescription>
            Talk to Cas from claude.ai or the Claude app. In Claude, go to Settings → Connectors →
            Add custom connector, paste this address, then sign in with your Cascadale account.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">Cascadale</p>
            <CopyField value={`${origin}${MCP_RESOURCES.tools}`} label="Cascadale connector address" />
            <p className="text-xs text-muted-foreground">
              Your money, Cas&rsquo;s notes and the actions. This is the one to add.
            </p>
          </div>
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">Cas (older)</p>
            <CopyField value={`${origin}${MCP_RESOURCES.cas}`} label="Cas connector address" />
            <p className="text-xs text-muted-foreground">
              Kept for connectors already set up. Cascadale does everything it does, faster.
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Change the password you sign in with.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/reset-password" />}
          >
            Change password
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Your data</CardTitle>
          <CardDescription>
            Everything is stored in your Supabase project.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p>
            Accounts, transactions, rules, budgets and settings live in its
            Postgres database.
          </p>
          <p>
            The original statement files you imported are kept in the{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              statements
            </code>{" "}
            storage bucket.
          </p>
          <p className="text-muted-foreground">
            Back up from the Supabase dashboard (Database → Backups) or with{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              supabase db dump
            </code>
            .
          </p>
        </CardContent>
      </Card>
      <Card className="md:hidden">
        <CardHeader>
          <CardTitle>Sign out</CardTitle>
          {email && <CardDescription>Signed in as {email}.</CardDescription>}
        </CardHeader>
        <CardContent>
          <SignOutButton />
        </CardContent>
      </Card>
    </>
  )
}

/** Where this app is being served from, as the browser sees it (behind Vercel's proxy too). */
async function siteOrigin() {
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
  return `${proto}://${host}`
}
