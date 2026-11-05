// The app's three views of the same money: one person's own, the family's, and the
// accountant's desk with the workings. Each person opens on their own or the family's.

export const VIEWS = ["me", "family", "accountant"] as const
export type View = (typeof VIEWS)[number]

/** Views a person can open the app on. */
export const HOME_VIEWS = ["me", "family"] as const
export type HomeView = (typeof HOME_VIEWS)[number]

/** Someone in the household. */
export type Person = {
  id: string
  /** what they call themselves, else their email's name part */
  name: string
  isOwner: boolean
}

export const parseView = (v: unknown): View | null =>
  VIEWS.includes(v as View) ? (v as View) : null
