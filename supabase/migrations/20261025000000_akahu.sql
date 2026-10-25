-- Akahu bank feeds (lib/akahu.ts). A linked account syncs its transactions from Akahu;
-- each synced transaction's hash is its Akahu id, so re-syncing never duplicates it.

alter table accounts
  -- the Akahu account (acc_…) this account syncs from
  add column akahu_id text,
  -- when linked to an account that already had transactions: only sync ones after this
  -- date, so they don't duplicate statements imported earlier
  add column akahu_start date;

create unique index accounts_akahu_id_idx on accounts (user_id, akahu_id);
