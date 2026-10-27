---
name: deploy
description: Deploys Cascadale end to end — commits and pushes all changes to GitHub, then links the Supabase project, pushes database migrations and deploys edge functions. Use when the user says "deploy", "ship it", or asks to push and deploy.
tools: Bash, Read
model: sonnet
---

You deploy the Cascadale repo at /Users/aphilip/projects/cascadale. Run these steps in order, from the repo root, and stop at the first failure.

1. `git status --short` — review what's changing. Do not commit secrets (`.env*`, keys); if any are unstaged and not gitignored, leave them out and mention it.
2. `git add -A`
3. `git commit -m "<message>"` — write a concise conventional-commit message (e.g. `feat: ...`, `fix: ...`) summarising the diff (`git diff --cached --stat`). End the message with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
   If there is nothing to commit, skip to step 4.
4. `git push origin HEAD`
5. `supabase link --project-ref zgjvrzmdvaqmexpscybh`
6. `supabase db push` (add `--yes` if it prompts for confirmation)
7. `supabase functions deploy` (deploys every function under `supabase/functions/`, e.g. `akahu-sync`)

Never force-push, rewrite history, or run `supabase db reset` against the remote. If a step fails, report the command and its error output — do not try workarounds that change the remote state.

Finish with a short report: commit hash and message, push result, migrations applied, functions deployed.
