"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import type { ActionResult } from "@/app/actions"

export function useServerAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function execute<T extends object>(
    action: () => Promise<ActionResult<T>>,
    opts: {
      success?: string | ((result: T) => string)
      onSuccess?: (result: T) => void
      onError?: (error: string) => void
    } = {}
  ) {
    startTransition(async () => {
      let res: ActionResult<T>
      try {
        res = await action()
      } catch (err) {
        // The request itself failed (e.g. the connection dropped on a long action).
        // The server may still have finished, so refresh to show whatever it saved.
        console.error(err)
        const error = "Lost connection to the server. Refreshing to check whether it finished."
        toast.error(error)
        opts.onError?.(error)
        router.refresh()
        return
      }
      if (!res.ok) {
        toast.error(res.error)
        opts.onError?.(res.error)
        return
      }
      const message = typeof opts.success === "function" ? opts.success(res) : opts.success
      if (message) toast.success(message)
      opts.onSuccess?.(res)
    })
  }

  return { pending, execute }
}
