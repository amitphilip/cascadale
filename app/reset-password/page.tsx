import type { Metadata } from "next"

import { ResetPasswordForm } from "./reset-password-form"
import { PageHeader } from "@/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export const metadata: Metadata = { title: "Set a new password" }

// proxy.ts keeps this page to signed-in users: a reset link signs you in before landing here.
export default function ResetPasswordPage() {
  return (
    <>
      <PageHeader title="Set a new password" />
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>New password</CardTitle>
          <CardDescription>
            You&apos;ll use it the next time you sign in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm />
        </CardContent>
      </Card>
    </>
  )
}
