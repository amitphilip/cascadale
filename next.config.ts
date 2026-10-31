import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  allowedDevOrigins: ["air.local", "0.0.0.0"],
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ]
  },
}

export default nextConfig
