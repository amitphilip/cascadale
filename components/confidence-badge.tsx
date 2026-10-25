import { SparkleIcon } from "@phosphor-icons/react/ssr"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** "AI 82%" / "Rule 100%", red when it needs a look. */
export function ConfidenceBadge({
  source,
  confidence,
  className,
}: {
  source: "manual" | "rule" | "ai" | null
  confidence: number | null
  className?: string
}) {
  const pct = confidence ?? 0
  return (
    <Badge
      variant={pct < 70 ? "destructive" : "outline"}
      className={cn("tabular-nums", pct >= 70 && "text-muted-foreground", className)}
      title={
        source === "ai"
          ? `Categorized by AI with ${pct}% confidence`
          : `Matched by a rule with ${pct}% confidence`
      }
    >
      {source === "ai" && <SparkleIcon data-icon="inline-start" />}
      {source === "ai" ? "AI" : "Rule"} {pct}%
    </Badge>
  )
}
