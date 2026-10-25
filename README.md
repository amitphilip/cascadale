# The Goal

An app for analysing your personal finances. Import bank and card statements,
categorize transactions (by hand or with rules), set budgets, and see where your
money goes.

Built with Next.js, shadcn/ui (Base UI) and [Supabase](https://supabase.com):
Postgres for the data, Storage for the original statement files.

## Set up

1. Create a Supabase project, then link this repo to it and apply the schema:

   ```bash
   npm install
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npm run db:push    # applies supabase/migrations/, seeds default categories
   ```

2. Copy `.env.example` to `.env.local` and fill in `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY` (Project Settings → API Keys).

3. Create your user under Authentication → Users (email and password). There's
   no sign-up page. New users get the default categories.

4. Run it and sign in:

   ```bash
   npm run dev        # http://localhost:3000
   ```

Add your Anthropic API key under **Settings → AI** (stored in the `settings`
table), or set `ANTHROPIC_API_KEY` in `.env`.

To sync bank feeds through Akahu, deploy the edge function and give it its secrets.
`AKAHU_CRON_SECRET` is any long random string; the hourly job sends it to the function.
The Akahu tokens are only needed here if you use the env fallback instead of Settings.

```bash
npx supabase functions deploy akahu-sync
npx supabase secrets set AKAHU_CRON_SECRET=<random> AKAHU_APP_TOKEN=… AKAHU_USER_TOKEN=…
```

Then, in the SQL editor, store what the hourly job (pg_cron) needs to call it:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the same AKAHU_CRON_SECRET>', 'akahu_cron_secret');
```

## Where your data lives

| Where                         | Contents                                   |
| ----------------------------- | ------------------------------------------ |
| Postgres (`public` schema)    | accounts, transactions, rules, plans, etc. |
| Storage bucket `statements`   | original statement files you imported      |

Every row has a `user_id` (defaulting to the signed-in user) and row level
security limits each user to their own rows; statement files live under
`<user id>/` in the bucket with matching storage policies. The app talks to
Supabase only as the signed-in user, with the publishable key and the session
cookies. `proxy.ts` refreshes the session and sends anyone signed out to
`/sign-in`.

## How it works

- **Accounts:** balance = opening balance + all transactions. Amounts are
  signed (negative = money out).
- **Import (CSV/TSV):** the header row, columns, date format and amount layout
  (one signed column, or separate debit/credit) are detected, and you can
  override any of them with a live preview. Re-importing overlapping statements
  is safe because rows are deduplicated per account. Each import can be undone
  from the import history.
- **Bank feeds (Akahu):** for New Zealand banks, save your
  [Akahu personal app](https://developers.akahu.nz/docs/personal-apps) tokens
  in Settings (or set `AKAHU_APP_TOKEN` and `AKAHU_USER_TOKEN`), then link each
  Akahu account to one of yours on the Import page. The `akahu-sync` edge
  function pulls in new transactions every hour and when you press Sync now,
  categorizing them with your rules; a manual sync also runs AI categorization.
  Transactions are deduplicated by their Akahu id; an account that already had
  transactions only syncs ones dated after its latest.
- **Rules:** "description contains X → category". The longest match wins. Rules
  run on import and can be applied to existing uncategorized transactions.
- **Categories:** each is an expense, income or transfer. Transfers (moving
  money between your own accounts, card payments) are excluded from income
  and spending. Expense categories can have a monthly budget.
- **Manual input:** add cash transactions, edit anything, and attach notes.

## Use it from Claude (MCP)

Two MCP servers (Streamable HTTP), each added to claude.ai as its own connector:

| Connector     | URL                  | Purpose                                                       |
| ------------- | -------------------- | ------------------------------------------------------------- |
| **The Goal**  | `/api/mcp`           | Your data and actions, as plain tools                         |
| **Cas**  | `/api/mcp/cas`  | Your financial advisor and accountant, as an agent            |

- **The Goal** has the read tools (`get_briefing`, `get_sync_status`,
  `get_financial_picture`, `search_transactions`, …) and the action tools
  (`sync_bank_feeds`, `categorize_merchant`, `set_category_budgets`,
  `add_upcoming_expense`, `run_check_in`, …). Actions change your data, and
  Claude is told to ask you first.
- **Cas** has `ask_cas`, which hands a question to the agent
  ([lib/cas/agent.ts](lib/cas/agent.ts), Claude Opus 5.5 with the
  Anthropic key from Settings). It works through the read tools on its own,
  checks feed health, books, cash flow, budgets, bills and plan, and answers with
  suggested actions for Claude to run on The Goal. It never changes your finances
  itself; it keeps notes (`cas_notes`) to remember decisions and to-dos
  between conversations, which `get_notes` and `resolve_note` expose.

Tools are defined once in [lib/cas/tools.ts](lib/cas/tools.ts). Both
servers sign in through Supabase Auth's OAuth 2.1 server, so clients act as you,
and row level security still applies.

1. `npm run db:push` to add the `cas_notes` table.
2. In the Supabase dashboard, open **Authentication → OAuth Server**: enable it,
   turn on dynamic client registration, and set the authorization path to
   `/oauth/consent` (local `supabase/config.toml` already does this). Also set
   **Authentication → URL Configuration → Site URL** to where the app is deployed.
3. Deploy the app somewhere public over HTTPS; claude.ai can't reach `localhost`.
   `ask_cas` can take a few minutes, so allow long requests (its route sets
   `maxDuration = 300`).
4. In claude.ai, go to **Settings → Connectors → Add custom connector** twice:
   The Goal at `https://<your app>/api/mcp` and Cas at
   `https://<your app>/api/mcp/cas`. Sign in and allow each.

## Development

```bash
npm run typecheck
npm run lint
npx supabase migration new <change>   # then write SQL in supabase/migrations/
npm run db:push                       # apply new migrations to the linked project
```

For a local database instead, `npx supabase start` (needs Docker) runs the
stack and applies the migrations; point `.env.local` at the URL and publishable key it
prints. `npm run db:reset` rebuilds it from the migrations.

| Where                         | What                                          |
| ----------------------------- | --------------------------------------------- |
| `supabase/migrations/`        | schema, default categories, query functions   |
| `lib/db/`                     | per-request Supabase client, row types        |
| `proxy.ts`, `app/sign-in/`    | session refresh, sign-in redirect and page    |
| `lib/import/parse.ts`         | CSV mapping/parsing, shared client+server     |
| `lib/queries.ts`              | read queries for pages                        |
| `app/actions.ts`              | all mutations (server actions)                |
| `app/api/statements/upload/`  | stores uploaded files, returns raw rows       |

Aggregations (balances, statements, review, imports) are Postgres functions in
the migration, called with `.rpc()`. Simple reads and writes go through
PostgREST, aliasing snake_case columns to the camelCase types in
`lib/db/schema.ts` (see `COLUMNS` in `lib/db/index.ts`).
