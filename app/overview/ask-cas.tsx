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
      className="grid gap-3 rounded-2xl bg-primary p-5 text-primary-foreground max-sm:p-4"
      onSubmit={(e) => {
        e.preventDefault()
        const q = question.trim()
        if (!q) return
        window.open(`https://claude.ai/new?q=${encodeURIComponent(`Ask Cas: ${q}`)}`, "_blank", "noopener,noreferrer")
        setQuestion("")
      }}
    >
      <label htmlFor="ask-cas" className="grid gap-0.5">
        <span className="font-heading text-lg font-semibold">Ask Cas</span>
        <span className="text-sm text-primary-foreground/75">Your accountant, about anything money.</span>
      </label>
      <div className="flex gap-2">
        <Input
          id="ask-cas"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Can we afford a weekend away?"
          enterKeyHint="send"
          className="h-10 border-transparent bg-primary-foreground text-foreground placeholder:text-foreground/45 dark:bg-background dark:text-foreground"
        />
        <Button
          type="submit"
          size="icon"
          variant="secondary"
          className="size-10 shrink-0 bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25 disabled:opacity-60" aria-label="Ask Cas in Claude" disabled={!question.trim()}>
          <PaperPlaneRightIcon />
        </Button>
      </div>
      <p className="text-xs text-primary-foreground/65">Opens in Claude, where Cas can see your accounts.</p>
    </form>
  )
}
