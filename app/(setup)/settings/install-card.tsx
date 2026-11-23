"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

type Mode = "installed" | "prompt" | "ios" | "other"

export function InstallApp() {
  const [mode, setMode] = useState<Mode>("other")
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null)

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only detection
    if (standalone) setMode("installed")
    else if (ios) setMode("ios")

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setPrompt(e as InstallPrompt)
      setMode("prompt")
    }
    const onInstalled = () => setMode("installed")
    window.addEventListener("beforeinstallprompt", onPrompt)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  if (mode === "installed")
    return <p className="text-sm">Installed. You are using the app.</p>
  if (mode === "prompt" && prompt)
    return (
      <Button
        onClick={async () => {
          await prompt.prompt()
          const { outcome } = await prompt.userChoice
          if (outcome === "accepted") setMode("installed")
          setPrompt(null)
        }}
      >
        Install app
      </Button>
    )
  if (mode === "ios")
    return (
      <p className="text-sm text-muted-foreground">
        In Safari, tap the Share button, then Add to Home Screen.
      </p>
    )
  return (
    <p className="text-sm text-muted-foreground">
      Open this site in Chrome, Edge or Safari on your phone and choose Install
      app, or Add to Home Screen, from the browser menu.
    </p>
  )
}
