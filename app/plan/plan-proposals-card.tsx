import { SparkleIcon } from "@phosphor-icons/react/ssr"

import { ProposalButtons } from "./proposal-buttons"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { describeProposal } from "@/lib/cas/proposals"
import type { Proposal } from "@/lib/cas/store"
import { formatDate } from "@/lib/format"

/** Changes Cas proposes, waiting for you to approve or reject them. */
export function PlanProposalsCard({
  proposals,
  locale,
}: {
  proposals: Proposal[]
  locale: string
}) {
  if (proposals.length === 0) return null
  return (
    <Card id="proposals">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparkleIcon /> Cas suggests
        </CardTitle>
        <CardDescription>
          {proposals.length} {proposals.length === 1 ? "change" : "changes"} to
          approve or reject. Nothing changes until you approve.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {proposals.map((p) => {
            const summary = describeProposal(p)
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-pretty">{summary}</div>
                  <p className="text-sm text-pretty text-muted-foreground">
                    {p.reason}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.source === "system" ? "From a new transaction" : "From Cas"} ·{" "}
                    {formatDate(p.createdAt.slice(0, 10), locale)}
                  </p>
                </div>
                <ProposalButtons proposalId={p.id} summary={summary} />
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
