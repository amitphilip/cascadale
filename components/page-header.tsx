import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  description,
  children,
  iconActions = false,
}: {
  title: string
  description?: React.ReactNode
  children?: React.ReactNode
  /** Actions are icon buttons: they stay top right on phones instead of stacking full width. */
  iconActions?: boolean
}) {
  return (
    <div
      className={cn(
        "flex",
        iconActions
          ? "items-start justify-between gap-4"
          : "flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4"
      )}
    >
      <div className="min-w-0">
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div
          className={
            iconActions
              ? "flex shrink-0 items-center gap-2"
              : "flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center"
          }
        >
          {children}
        </div>
      )}
    </div>
  )
}
