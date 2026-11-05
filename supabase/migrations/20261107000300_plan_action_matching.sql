-- Action items that move money can be ticked off by the transactions that show it was done.
-- An item with an amount and an account is matched after each sync (lib/action-matching.ts):
-- a single clear match ticks it off as 'system' with the transaction linked; several possible
-- ones become a proposal instead.

alter table plan_actions
  add column amount numeric(14, 2) check (amount is null or amount > 0),
  add column from_account_id integer references accounts (id) on delete set null,
  add column to_account_id integer references accounts (id) on delete set null,
  -- who ticked it off, and the transaction that showed it was done
  add column done_by text check (done_by in ('website', 'mcp', 'cas', 'user', 'system')),
  add column done_transaction_id integer references transactions (id) on delete set null;

create index plan_actions_open_idx on plan_actions (user_id, id) where done_at is null;
