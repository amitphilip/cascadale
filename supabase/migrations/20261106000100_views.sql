-- Views for each person: whose each account is, and each person's name and the view the
-- app opens on (their own money, or the family's).

-- null: a joint account, or one nobody has claimed
alter table accounts add column holder_id uuid references auth.users (id) on delete set null;

create table user_prefs (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text,
  home_view text not null default 'family' check (home_view in ('me', 'family')),
  updated_at timestamptz not null default now()
);

alter table user_prefs enable row level security;
create policy "own prefs" on user_prefs for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Everyone in the signed-in user's household, the owner first, with their names.
create function household_people()
returns table (id uuid, email text, name text, is_owner boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with o as (select public.data_owner() as id)
  select u.id, u.email::text, p.name, u.id = o.id
  from o
  join auth.users u
    on u.id = o.id
    or u.id in (select m.member_id from public.household_members m where m.owner_id = o.id)
  left join public.user_prefs p on p.user_id = u.id
  order by u.id = o.id desc, u.created_at
$$;

-- category_spend, for spending from some accounts only.
create function category_spend_for(p_start date, p_end date, p_accounts integer[])
returns table (id integer, name text, budget numeric, spent numeric)
language sql stable as $$
  select c.id, c.name, c.monthly_budget, -sum(t.amount) as spent
  from transactions t
  left join categories c on c.id = t.category_id
  where t.date >= p_start and t.date < p_end
    and t.account_id = any (p_accounts)
    and (c.kind = 'expense' or (c.id is null and t.amount < 0))
  group by c.id, c.name, c.monthly_budget
  order by spent desc
$$;

revoke execute on function household_people(), category_spend_for(date, date, integer[])
  from public, anon;
grant execute on function household_people(), category_spend_for(date, date, integer[])
  to authenticated;

-- This household: Amit owns it and Mary is a member. Name them, and give each the
-- accounts with their name in it; the rest stay joint.
insert into user_prefs (user_id, name)
select id, case when email = 'marysimson@gmail.com' then 'Mary' else 'Amit' end
from auth.users
where email in ('marysimson@gmail.com', 'amit.a.philip@gmail.com')
on conflict (user_id) do nothing;

update accounts a
set holder_id = u.id
from auth.users u
where a.holder_id is null
  and a.name !~* 'joint'
  and (
    (u.email = 'marysimson@gmail.com' and a.name ~* '\mmary\M')
    or (u.email = 'amit.a.philip@gmail.com' and a.name ~* '\mamit')
  );
