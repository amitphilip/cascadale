import { ImageResponse } from "next/og"

import { LOGO_PATH } from "@/components/logo"

const SIZES = new Set([192, 512])

/** PWA icons for the manifest: /icons/192, /icons/512 and /icons/maskable-512. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> }
) {
  const { size: raw } = await params
  const maskable = raw.startsWith("maskable-")
  const size = Number(raw.replace("maskable-", ""))
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 })

  // Maskable icons get cropped to a circle or squircle, so keep the mark in the middle 60%.
  const mark = Math.round(size * (maskable ? 0.5 : 0.7))
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#171717",
      }}
    >
      <svg width={mark} height={mark} viewBox="0 0 32 32">
        <path
          d={LOGO_PATH}
          fill="none"
          stroke="#fff"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>,
    { width: size, height: size }
  )
}
