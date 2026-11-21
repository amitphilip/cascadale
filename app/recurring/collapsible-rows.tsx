"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * Phones get each row as a small grid instead of seven columns: name and projection on the
 * first line, basis and budget under them. Cells place themselves with max-sm:col/row-start.
 */
export const MOBILE_ROW = "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-start"

// Category rows that fold their recurring items and "everything else" away. Every category
// starts folded; a link to #budget-<category id> (e.g. from another page's "edit budget")
// opens that one and scrolls to it.

type Groups = {
  open: Set<string>
  toggle: (key: string) => void
  setAll: (open: boolean) => void
  keys: string[]
}

const GroupsContext = createContext<Groups | null>(null)

/** Holds which categories are open, for the rows and the expand/collapse all button inside it. */
export function CollapsibleGroups({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1)
      const key = keys.find((k) => `budget-${k}` === id)
      if (!key) return
      setOpen((s) => new Set(s).add(key))
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "center" }))
    }
    fromHash()
    window.addEventListener("hashchange", fromHash)
    return () => window.removeEventListener("hashchange", fromHash)
  }, [keys])

  const groups: Groups = {
    open,
    keys,
    toggle: (key) =>
      setOpen((s) => {
        const next = new Set(s)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    setAll: (all) => setOpen(all ? new Set(keys) : new Set()),
  }
  return <GroupsContext.Provider value={groups}>{children}</GroupsContext.Provider>
}

function useGroups() {
  const groups = useContext(GroupsContext)
  if (!groups) throw new Error("Use inside CollapsibleGroups")
  return groups
}

/** Expands every category, or collapses them all once any is open. */
export function ExpandAllButton() {
  const { open, keys, setAll } = useGroups()
  const anyOpen = open.size > 0
  if (keys.length === 0) return null
  return (
    <Button variant="ghost" size="sm" onClick={() => setAll(!anyOpen)}>
      {anyOpen ? "Collapse all" : "Expand all"}
    </Button>
  )
}

/**
 * A category's row, with a caret that shows or hides its detail rows. `name` is the first
 * cell's content and `cells` the rest of the row.
 */
export function CategoryGroup({
  groupKey,
  anchor,
  name,
  cells,
  detailCount,
  children,
}: {
  groupKey: string
  /** id to link to, e.g. budget-12 */
  anchor?: string
  name: React.ReactNode
  cells: React.ReactNode
  /** how many detail rows there are; 0 hides the caret */
  detailCount: number
  children: React.ReactNode
}) {
  const { open, toggle } = useGroups()
  const isOpen = open.has(groupKey)
  return (
    <>
      <TableRow id={anchor} className={cn("scroll-mt-24 bg-muted/40 font-medium", MOBILE_ROW)}>
        <TableCell className="pl-[calc(var(--card-spacing)-0.5rem)] max-sm:col-start-1 max-sm:row-start-1 max-sm:min-w-0 max-sm:pb-0 max-sm:whitespace-normal">
          <div className="flex items-start gap-1">
            {detailCount > 0 ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="mt-0.5 shrink-0 max-sm:size-9"
                aria-expanded={isOpen}
                aria-label={isOpen ? "Hide items" : `Show ${detailCount} item${detailCount === 1 ? "" : "s"}`}
                onClick={() => toggle(groupKey)}
              >
                {isOpen ? <CaretDownIcon /> : <CaretRightIcon />}
              </Button>
            ) : (
              <span className="size-7 shrink-0 max-sm:size-9" aria-hidden />
            )}
            <div className="min-w-0 py-1">{name}</div>
          </div>
        </TableCell>
        {cells}
      </TableRow>
      {isOpen && children}
    </>
  )
}
