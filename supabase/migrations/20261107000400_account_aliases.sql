-- What each account is for, and other names people call it, so "the rates account" or "Tax"
-- finds the right one (lib/account-lookup.ts). Shown and edited on the Accounts page.

alter table accounts
  add column purpose text,
  add column aliases text[] not null default '{}';

-- The household's rates account, by its bank name, when it has one and nothing's set yet.
update accounts
set aliases = array['rates', 'rates account'],
    purpose = coalesce(purpose, 'Council rates')
where lower(trim(name)) = 'short term invest'
  and aliases = '{}';
