"use client"

import { useEffect } from "react"

/** Registers the app-shell service worker that makes Cascadale installable. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator))
      return
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {})
  }, [])
  return null
}
