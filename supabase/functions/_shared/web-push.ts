// Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
// on WebCrypto alone, so it runs the same in the edge function (Deno) and in tests (Node).
//
// Shared by the Next.js app's tests and the akahu-sync edge function, so it imports nothing.

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string }

/** VAPID keys as base64url: the public key raw (65 bytes), the private key its `d` (32 bytes). */
export type VapidKeys = { publicKey: string; privateKey: string; subject: string }

const enc = new TextEncoder()

export function b64url(bytes: Uint8Array) {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromB64url(s: string) {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8
  )
  return new Uint8Array(bits)
}

/** Encrypt a payload for one subscription: the aes128gcm body, as one record. */
export async function encryptPayload(
  payload: Uint8Array,
  sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  // for tests: a fixed sender key pair and salt
  fixed?: { senderKeys: CryptoKeyPair; salt: Uint8Array }
) {
  const uaPublic = fromB64url(sub.p256dh)
  const authSecret = fromB64url(sub.auth)
  const sender =
    fixed?.senderKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair)
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey))
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256)
  )

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12)

  // one record: the payload, then the last-record delimiter
  const plain = concat(payload, new Uint8Array([2]))
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"])
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, plain as BufferSource)
  )

  const rs = 4096
  const header = concat(
    salt,
    new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPublic.length]),
    asPublic
  )
  return concat(header, cipher)
}

/** The VAPID Authorization header for an endpoint, signed with the private key (ES256). */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()) {
  const pub = fromB64url(vapid.publicKey)
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      })
    )
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`))
  )
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`
}

/**
 * Send one push message. Returns the push service's status: 201 sent; 404 or 410 means the
 * subscription is gone and should be deleted.
 */
export async function sendPush(sub: PushSubscriptionKeys, message: unknown, vapid: VapidKeys) {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub)
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(24 * 60 * 60),
      Urgency: "normal",
    },
    body: body as BodyInit,
  })
  await res.body?.cancel()
  return res.status
}
