"use client"

import { setAccountHolder } from "@/app/actions"
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

/** Whose an account is: someone in the household, or joint. Decides what each person's own view shows. */
export function AccountHolderSelect({
  account,
  holderId,
  people,
}: {
  account: { id: number; name: string }
  holderId: string | null
  people: Person[]
}) {
  const { pending, execute } = useServerAction()
  const items = [
    { value: JOINT, label: "Joint" },
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ]
  return (
    <Select
      items={items}
      value={holderId ?? JOINT}
      disabled={pending}
      onValueChange={(v) =>
        execute(() => setAccountHolder(account.id, v === JOINT || !v ? null : String(v)), {
          success: `${account.name} updated`,
        })
      }
    >
      <SelectTrigger size="sm" className="w-full max-sm:h-10 sm:w-36" aria-label={`Whose is ${account.name}`}>
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
  )
}
