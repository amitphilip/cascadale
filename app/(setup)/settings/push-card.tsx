"use client"

import { useEffect, useState, useTransition } from "react"
import { BellRingingIcon, BellSlashIcon } from "@phosphor-icons/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { disablePush, enablePush, pushEnabled, pushSupported } from "@/lib/push-client"

type State = "loading" | "unsupported" | "on" | "off"

/** Turns Cas's push notifications on or off for this device. */
export function PushToggle() {
  const [state, setState] = useState<State>("loading")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let live = true
    if (!pushSupported()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only detection
      setState("unsupported")
      return
    }
    pushEnabled()
      .then((on) => live && setState(on ? "on" : "off"))
      .catch(() => live && setState("off"))
    return () => {
      live = false
    }
  }, [])

  if (state === "unsupported") {
    return (
      <p className="text-sm text-muted-foreground">
        This browser can&rsquo;t show notifications. On an iPhone, add Cascadale to your home screen first, then
        turn them on from there.
      </p>
    )
  }

  const on = state === "on"
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm">
        {state === "loading" ? "Checking this device…" : on ? "On for this device." : "Off for this device."}
      </p>
      <Button
        variant={on ? "outline" : "default"}
        disabled={state === "loading" || pending}
        className="max-sm:h-10 max-sm:w-full"
        onClick={() =>
          startTransition(async () => {
            if (on) {
              await disablePush()
              setState("off")
              toast.success("Cas messages turned off on this device")
              return
            }
            const res = await enablePush()
            if (res.ok) {
              setState("on")
              toast.success("Cas messages turned on")
            } else toast.error(res.error)
          })
        }
      >
        {on ? <BellSlashIcon data-icon="inline-start" /> : <BellRingingIcon data-icon="inline-start" />}
        {on ? "Turn off" : "Turn on"}
      </Button>
    </div>
  )
}
