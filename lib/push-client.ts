"use client"

import { removePushSubscription, savePushSubscription } from "@/app/push-actions"

// Turning Cas's push messages on and off on this device. The VAPID public key comes from
// NEXT_PUBLIC_VAPID_PUBLIC_KEY; the matching private key is a secret of the akahu-sync
// edge function, which sends the messages.

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

/** The service worker, registered if it isn't yet (it's only registered in production builds). */
async function registration() {
  const existing = await navigator.serviceWorker.getRegistration("/")
  if (existing) return existing
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
  return navigator.serviceWorker.ready
}

export async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== "granted") return false
  const reg = await navigator.serviceWorker.getRegistration("/")
  return Boolean(await reg?.pushManager.getSubscription())
}

/** The base64url VAPID key as the bytes PushManager wants. */
function keyBytes(base64url: string) {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export async function enablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!pushSupported()) {
    return { ok: false, error: "This browser can't show notifications. On iPhone, add Cascadale to your Home Screen first." }
  }
  if (!PUBLIC_KEY) return { ok: false, error: "Push isn't set up on the server yet (NEXT_PUBLIC_VAPID_PUBLIC_KEY)." }
  const permission = await Notification.requestPermission()
  if (permission !== "granted") return { ok: false, error: "Notifications are blocked for Cascadale in this browser's settings." }
  try {
    const reg = await registration()
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUBLIC_KEY) }))
    const saved = await savePushSubscription(sub.toJSON())
    if (!saved.ok) return saved
    return { ok: true }
  } catch (err) {
    console.error(err)
    return { ok: false, error: "Couldn't turn on notifications on this device." }
  }
}

export async function disablePush() {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.getRegistration("/")
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await removePushSubscription(sub.endpoint)
  await sub.unsubscribe()
}
