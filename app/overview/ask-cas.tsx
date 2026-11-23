"use client"

import { useState } from "react"
import { PaperPlaneRightIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Cas lives in Claude, through the Cascadale connector: a question opens a new chat there. */
export function AskCas() {
  const [question, setQuestion] = useState("")

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const q = question.trim()
        if (!q) return
        window.open(`https://claude.ai/new?q=${encodeURIComponent(`Ask Cas: ${q}`)}`, "_blank", "noopener,noreferrer")
        setQuestion("")
      }}
    >
      <label htmlFor="ask-cas" className="text-sm font-medium">
        Ask Cas
      </label>
      <div className="flex gap-2">
        <Input
          id="ask-cas"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Can we afford a weekend away?"
          enterKeyHint="send"
          className="h-10"
        />
        <Button type="submit" size="icon" className="size-10 shrink-0" aria-label="Ask Cas in Claude" disabled={!question.trim()}>
          <PaperPlaneRightIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Opens in Claude, where Cas can see your accounts.</p>
    </form>
  )
}
