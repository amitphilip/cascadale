"use client"

import { UsersThreeIcon } from "@phosphor-icons/react"

import { setAccountHolder } from "@/app/actions"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useServerAction } from "@/hooks/use-server-action"
import type { Person } from "@/lib/views"

const JOINT = "joint"

/** Whose each account is, which decides what each person's own view shows. */
export function AccountHoldersCard({
  accounts,
  people,
}: {
  accounts: { id: number; name: string; holderId: string | null }[]
  people: Person[]
}) {
  const { pending, execute } = useServerAction()
  const items = [
    { value: JOINT, label: "Joint" },
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UsersThreeIcon /> Whose accounts
        </CardTitle>
        <CardDescription>
          Each person’s own view shows their accounts and the pay that lands in
          them. Joint accounts show in the family view.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3 text-sm"
            >
              <span className="truncate" title={a.name}>
                {a.name}
              </span>
              <Select
                items={items}
                value={a.holderId ?? JOINT}
                disabled={pending}
                onValueChange={(v) =>
                  execute(
                    () => setAccountHolder(a.id, v === JOINT || !v ? null : String(v)),
                    { success: `${a.name} updated` }
                  )
                }
              >
                <SelectTrigger size="sm" className="w-full" aria-label={`Whose is ${a.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
