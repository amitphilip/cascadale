# Cas and Cascadale architecture changes - plan

This maps each phase of the brief to the code as it is, and flags where the brief
doesn't match the repo. Each phase ships as its own commit with its migration and tests.

## The repo as it is

| Piece | Where | Notes |
| --- | --- | --- |
| Website | Next.js 16 app (`app/`), server actions in `app/actions.ts` | Acts as the signed-in user with the publishable key; row level security scopes everything to the household (`data_owner()`). |
| MCP servers | `lib/mcp.ts`, routes `app/api/mcp` (Cascadale) and `app/api/mcp/cas` (Cas) | Stateless Streamable HTTP, OAuth tokens from Supabase Auth. |
| Tools | `lib/cas/tools.ts` (`TOOLS`), plan tools `lib/cas/plan-tools.ts` | Already one list: the Cascadale MCP server registers the read and action tools, the Cas agent gets the read and memory tools. |
| Cas's harness | `lib/cas/agent.ts` | `askCas` (MCP `ask_cas`) and `planChat` (Plan page chat). Tool runner on `claude-opus-5-5`, hard-coded. Runs inside the Next.js app, not in Supabase. |
| Plan service | `lib/plan-service.ts` over `PlanRepo` (`lib/plan-repo.ts`, in-memory `tests/memory-repo.ts`) | The plan is worked out on read (`livePlan`): the last model plan carried to today's data with pots and adjustments applied. Writes go through `once()`: idempotent on `operationId`, logged in `plan_changes` with actor and reason. |
| Simulation | `lib/plan.ts` (`simulate`, `combinedLow`), `lib/plan-goal.ts` (`planGoal`, `endPosition`), `lib/plan-budget.ts` (`spareCash`) | Pure functions. |
| Data health / drift | `lib/health.ts` (pure), `lib/data-health.ts` (loader) | |
| Bank sync | Supabase edge function `supabase/functions/akahu-sync`, hourly via pg_cron | Service role. Logs one `akahu_syncs` row per account per run. The app's Sync now calls the same function. |
| Supabase functions | Only `akahu-sync` | |
| Inngest | **None** | |

## Where the brief doesn't fit

1. **There is no Inngest.** Nothing in the repo uses it. I add it: the `inngest`
   package (pinned 4.25.0), a client in `lib/inngest.ts`, and a serve route at
   `app/api/inngest`. The edge function sends `feeds/synced` with a plain HTTP POST
   (Deno, no SDK). An `.npmrc` sets `legacy-peer-deps` because npm trips over
   inngest's optional SvelteKit peer.
2. **Cas doesn't run in Supabase.** It runs in the Next.js app (`lib/cas/agent.ts`).
   The background worker therefore runs there too, as an Inngest function.
3. **Background work has no user session.** Everything reads through row level
   security as the signed-in user. The worker signs in as the household owner with a
   one-off session minted by the admin API (`SUPABASE_SECRET_KEY`, server only), so
   every existing query and policy works unchanged. This is the one new secret.
4. **The tool layer is already shared.** Cas and MCP call the same `TOOLS` entries,
   so they can't disagree on code path. The real disagreements are in the *figures*:
   - goal gap is worked out separately on the Plan page (`app/plan/page.tsx`) and in
     check-ins (`lib/checkin.ts`);
   - the briefing's low point (`sinceLastCheckIn.low`) is a no-plan projection,
     while the Plan page's is the plan's;
   - "overdue" on plan actions is only due date against today, so a transfer that
     already happened still reads as overdue (the example in the brief).
   Phase 1 adds one `planFigures()` for goal gap, low point, drift and action status,
   used by get_plan, get_briefing, the Plan page and the worker.
5. **`plan_changes` already exists** (operation id, actor, action, reason, summary,
   result). Phase 2 extends it instead of adding a table.
6. **Actors are `website`, `mcp`, `cas`**, not `web`. I keep `website` (existing rows
   and labels) and add `user` (approving a proposal) and `system` (auto-complete).
   The person is recorded as `changed_by` (`auth.uid()`).
7. **Plan actions have no amount or accounts** (title, detail, due date), so they can't
   be matched to transactions. Phase 6 adds optional `amount`, `from_account_id`,
   `to_account_id`; only actions with them are matched. Plan action writes also have
   no `operationId` or change log yet; Phase 1 routes them through `once()`.
8. **Only plan writes are logged.** Budgets, recategorisation, assets and upcoming
   expenses don't go through `plan_changes`. They stay as they are, except when run
   from an approved proposal, which is logged.
9. **No "Short Term Invest" account is in the repo** (real names live only in the
   database). The seed migration sets the aliases on an account with that name if
   there is one, and does nothing otherwise.
10. `ask_cas` and the Plan chat use `claude-opus-5-5` today; with tiering they default
    to the escalate model (`claude-sonnet-5-5`), configurable in Settings.

## Phases

### 1. Shared figures and writes
- `lib/plan-figures.ts`: `planFigures()` (pure) - status, goal gap, low point (combined,
  plan applied), spare cash, drift, plan action status (overdue only when not matched).
- `PlanRepo.goalPlan()` so the figures take the goal's plan from the repo.
- `get_plan` and `get_briefing` gain a `figures` field (additive; MCP server version
  0.2.0). The Plan page and check-ins use the same function.
- Plan action writes (`add_plan_action`, `set_plan_action_done`, `remove_plan_action`)
  go through `once()` with optional `operationId` and `reason`.

### 2. Change log and events
- Migration: `plan_changes` gets `changed_by`, `before`, `after`, `proposal_id`,
  `transaction_id`, and the new actors; a trigger makes completed rows append-only.
- `lib/events.ts`: `emit()` through Inngest, never failing a write. `once()` emits
  `plan/changed` (household id, change id, actor) for each new write, not replays.
- The edge function emits `feeds/synced` (household id, sync run id, latest transaction
  time) after a successful sync.
- Cas sees user changes since its last snapshot as decisions; proposals that would
  undo one are dropped and raised as a note instead.

### 3. Background Cas and the snapshot
- Migration: `cas_snapshots` with the fields in the brief plus tokens and latency.
- `lib/cas/worker.ts`: auto-complete (phase 6), figures, one structured model call for
  the headline, top actions and proposals, then the row.
- Inngest function `cas-snapshot` on `feeds/synced`, `plan/changed`, `cas/refresh`,
  debounced 90s per household (`event.data.householdId`), 10 minute cap.

### 4. Fast status tool
- `get_status` (no model): latest snapshot, `is_stale` and what's newer (changes,
  syncs). `refresh_cas` sends `cas/refresh`. Instructions updated on both servers.

### 5. Proposals with approval
- Migration: `cas_proposals`. `list_proposals`, `approve_proposal` (one or many),
  `reject_proposal`. Approval runs the stored call through the shared tools as `user`
  with the proposal linked on the change. A Plan page card with Approve and Reject.
- Pending proposals from an older state are marked `superseded` on the next run,
  unless Cas keeps them.

### 6. Auto-complete plan actions
- `lib/action-matching.ts` (pure): amount, accounts and date window. One match ticks
  it off as `system` with the transaction linked; several raise a proposal. Runs first
  in the worker, so the snapshot never reports finished work as overdue.

### 7. Account aliases and purpose
- Migration: `accounts.purpose`, `accounts.aliases`, seed for Short Term Invest.
- `lib/account-lookup.ts`: by name, alias or purpose, with candidates when ambiguous.
  `find_account` tool; plan tools accept `fromAccount` / `toAccount` names alongside
  ids. Fields in the account dialog.

### 8. Discrepancy reports
- Migration: note kind `discrepancy`. `report_discrepancy` saves the note through
  `once()`, which emits `plan/changed` and marks the snapshot stale.

### 9. Model tiering
- `lib/cas/models.ts`: per-task models from Settings (defaults Haiku 5.5 / Sonnet 5.5 /
  Opus 5.5) and the escalation rule (status change, gap moved past a threshold,
  check-in due). Model, tokens and latency recorded on each snapshot.

## Acceptance checks, and how they're tested

| Check | Test |
| --- | --- |
| `get_status` under a second, flags staleness | Unit test of the staleness logic; the tool makes three indexed reads and no model call. |
| One Cas run per burst, `based_on_change_id` matches | Debounce config test; `once()` emits once per write and not on replay; worker test that the snapshot records the latest change id. |
| Matching transfer ticks off an action | Matching tests, and worker test over the fixture. |
| Proposals approved from MCP and the Plan page, actor user | Approval test over the in-memory repo; both paths call the same function. |
| "Rates account" resolves to Short Term Invest | Account lookup test. |
| Cas and MCP return identical figures | Test calling `get_plan` (MCP) and the worker's figures on the same fixture. |

Live checks (Inngest dev server, a real sync) need a running stack and aren't run
here; nothing in this work writes to production.

## Status

All nine phases are in, one commit each, with migrations under `supabase/migrations/`
(`20261107000000` to `20261107000600`) and tests under `tests/`. The migrations were
applied in order to a scratch Postgres 16 with Supabase's auth and storage stubbed out;
none were pushed to a real project.

Still to check against a running stack (not possible here):
- Inngest end to end: the edge function's `feeds/synced` post, the debounce in practice,
  and `asHousehold` minting a session with the real admin API.
- Haiku 5.5 with structured output on a real snapshot, and the token and latency numbers.
- The Plan page's proposals card and the account dialog's new fields, in a browser.

Left as they were, on purpose:
- Categorisation stays on Opus 5.5 (`casModel.categorise` changes it); its web search
  tool and fallback now follow the model.
- Budgets, recategorisation and assets are only logged in `plan_changes` when they run
  from an approved proposal.
- Between a sync and Cas's run (up to 90 seconds plus the run), `get_plan` and
  `get_briefing` can still show an action as overdue that the run will tick off.
- There's no Settings screen for the models yet; they're settings rows or env vars.
