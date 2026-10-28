-- Households: family members share one user's data.
--
-- A member signs in as themselves but reads and writes the owner's rows. data_owner()
-- gives the owner for a member and the user themselves otherwise; row level security,
-- user_id defaults and the statement file folders all use it in place of auth.uid().

create table household_members (
  member_id uuid primary key references auth.users (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (member_id <> owner_id)
);

alter table household_members enable row level security;
create policy "own membership" on household_members for select to authenticated
  using (member_id = (select auth.uid()) or owner_id = (select auth.uid()));

-- Whose data the signed-in user works on.
create function data_owner()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select owner_id from public.household_members where member_id = auth.uid()),
    auth.uid()
  )
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'statements', 'rules', 'transactions', 'settings',
    'recurring_overrides', 'category_projections', 'plan_threads', 'plan_messages',
    'upcoming_expenses', 'check_ins', 'akahu_syncs', 'cas_notes'
  ] loop
    execute format('alter table %I alter column user_id set default public.data_owner()', t);
    execute format('drop policy "own rows" on %I', t);
    execute format(
      'create policy "household rows" on %I for all to authenticated '
      'using (user_id = (select public.data_owner())) '
      'with check (user_id = (select public.data_owner()))', t);
  end loop;
end;
$$;

drop policy "own statement files" on storage.objects;
create policy "household statement files" on storage.objects for all to authenticated
using (bucket_id = 'statements' and (storage.foldername(name))[1] = (select public.data_owner()::text))
with check (bucket_id = 'statements' and (storage.foldername(name))[1] = (select public.data_owner()::text));

-- Mary joins the first account's household. Her own default categories are dropped:
-- she works on the owner's from now on.
with member as (
  select id from auth.users where email = 'marysimson@gmail.com'
), owner as (
  select id from auth.users where email <> 'marysimson@gmail.com' order by created_at limit 1
)
insert into household_members (member_id, owner_id)
select member.id, owner.id from member, owner
on conflict (member_id) do nothing;

delete from categories c
using household_members m
where c.user_id = m.member_id;
