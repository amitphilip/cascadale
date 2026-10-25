export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          {children}
        </div>
      )}
    </div>
  )
}
