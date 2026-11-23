"use client"

import { useRouter } from "next/navigation"
import { SignOutIcon } from "@phosphor-icons/react"

import { signOut } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

export function SignOutButton() {
  const router = useRouter()
  const { pending, execute } = useServerAction()
  return (
    <Button
      variant="outline"
      disabled={pending}
      className="max-sm:h-10 max-sm:w-full"
      onClick={() =>
        execute(() => signOut(), {
          onSuccess: () => {
            router.replace("/sign-in")
            router.refresh()
          },
        })
      }
    >
      <SignOutIcon data-icon="inline-start" />
      Sign out
    </Button>
  )
}
