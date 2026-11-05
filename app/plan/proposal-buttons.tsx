"use client"

import { CheckIcon, XIcon } from "@phosphor-icons/react"

import { approveProposal, rejectProposal } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { useServerAction } from "@/hooks/use-server-action"

/** Approve or reject one of Cas's proposals. */
export function ProposalButtons({ proposalId, summary }: { proposalId: number; summary: string }) {
  const { pending, execute } = useServerAction()
  return (
    <div className="flex shrink-0 gap-2">
      <Button
        size="sm"
        disabled={pending}
        aria-label={`Approve: ${summary}`}
        onClick={() => execute(() => approveProposal(proposalId), { success: "Done" })}
      >
        <CheckIcon /> Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={`Reject: ${summary}`}
        onClick={() => execute(() => rejectProposal(proposalId), { success: "Rejected" })}
      >
        <XIcon /> Reject
      </Button>
    </div>
  )
}
