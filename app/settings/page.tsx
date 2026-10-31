import type { Metadata } from "next"
import Link from "next/link"

import { AkahuForm } from "./akahu-form"
import { ApiKeyForm } from "./api-key-form"
import { InstallApp } from "./install-card"
import { SettingsForm } from "./settings-form"
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
import { getApiKeyStatus } from "@/lib/anthropic"
import { getSettings } from "@/lib/queries"

export const metadata: Metadata = { title: "Settings" }

export default async function SettingsPage() {
  const [current, apiKey, akahu] = await Promise.all([
    getSettings(),
    getApiKeyStatus(),
    getAkahuStatus(),
  ])
  return (
    <>
      <PageHeader title="Settings" />
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
            personal app. Link accounts on the Import page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AkahuForm status={akahu} />
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
            Accounts, transactions, rules, plans and settings live in its
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
    </>
  )
}
