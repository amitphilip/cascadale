"use client"

import { useState } from "react"
import { SparkleIcon } from "@phosphor-icons/react"

import { PlanChat, type ChatMessage } from "./plan-chat"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

/** Sidebar chat on wide screens; a bottom sheet on phones so the plan can use the full width. */
export function PlanAsk({ threadId, messages }: { threadId: number; messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Card className="hidden min-h-0 xl:sticky xl:top-8 xl:flex xl:h-[calc(100svh-4rem)] xl:flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SparkleIcon /> Ask the planner
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          <PlanChat threadId={threadId} messages={messages} />
        </CardContent>
      </Card>

      <div className="xl:hidden">
        <Button
          className="fixed right-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] md:bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 shadow-lg"
          onClick={() => setOpen(true)}
        >
          <SparkleIcon data-icon="inline-start" />
          Ask the planner
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            className="data-[side=bottom]:h-[min(85dvh,36rem)] gap-3 overflow-hidden p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="p-0 pr-8">
              <SheetTitle className="flex items-center gap-2">
                <SparkleIcon /> Ask the planner
              </SheetTitle>
            </SheetHeader>
            <PlanChat threadId={threadId} messages={messages} />
          </SheetContent>
        </Sheet>
      </div>
    </>
  )
}
