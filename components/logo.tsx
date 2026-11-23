/** The Cascadale mark: water stepping down into the dale. Drawn in currentColor. */
export const LOGO_PATH =
  "M6 9h5c2 0 3 1 3 3v1c0 2 1 3 3 3h1c2 0 3 1 3 3v1c0 2 1 3 3 3h2"

/** The app icon's colours: the light theme's primary green, with the mark in its foreground. */
export const LOGO_BG = "#1d5a46"
export const LOGO_FG = "#f6f5f0"

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d={LOGO_PATH} />
    </svg>
  )
}
