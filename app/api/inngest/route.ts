import { serve } from "inngest/next"

import { functions } from "@/lib/cas/inngest"
import { inngest } from "@/lib/events"

// Inngest calls this to run Cas's background functions (lib/cas/inngest.ts). Requests are
// signed with INNGEST_SIGNING_KEY; proxy.ts lets them through without session cookies.

// a run asks a model once, which can take a minute or two
export const maxDuration = 300

export const { GET, POST, PUT } = serve({ client: inngest, functions })
