-- Upcoming expenses fold into one-off payments: one kind of known cost coming up, which the
-- plan, the Overview and Cas all read. Each upcoming expense still ahead becomes a one-off
-- paid in one go on its due date, from its account; past ones were reminders that have run
-- their course and go with the table.

-- The obstetric instalments were tracked twice: as upcoming expenses, one per instalment,
-- and as one one-off payment for the whole fee. Rather than copy them, the one-off takes on
-- what the instalments said: paid monthly in parts until the last one, from their account.
-- Only transactions in a one-off's own account count, so links in its old account go.
do $$
declare
  target one_offs%rowtype;
  inst record;
begin
  select u.user_id, max(u.account_id) as account_id, max(u.due_date) as last_due
    into inst
  from upcoming_expenses u
  where u.name ilike '%obstetric%' and u.due_date >= current_date and u.account_id is not null
  group by u.user_id
  limit 1;
  if not found then return; end if;

  if (select count(*) from one_offs o where o.user_id = inst.user_id and o.name ilike '%obstetric%') <> 1 then
    return;
  end if;
  select * into target from one_offs o where o.user_id = inst.user_id and o.name ilike '%obstetric%';

  update one_offs
  set account_id = inst.account_id,
      out_mode = 'spread',
      out_every = 'month',
      finish_date = greatest(inst.last_due, start_date)
  where id = target.id;

  delete from one_off_transactions l
  using transactions t
  where l.one_off_id = target.id and t.id = l.transaction_id and t.account_id <> inst.account_id;

  delete from upcoming_expenses u
  where u.user_id = inst.user_id and u.name ilike '%obstetric%';
end;
$$;

-- Every other upcoming expense still ahead, from an account, becomes a one-off paid in one
-- go. One with no account can't be tracked as a one-off and is left out (none exist now).
insert into one_offs (user_id, name, total, account_id, start_date, finish_date, out_mode, in_every, set_aside, note, created_at)
select u.user_id, u.name, u.amount, u.account_id,
  least(u.created_at::date, u.due_date), u.due_date, 'single', 'month', 0, u.note, u.created_at
from upcoming_expenses u
where u.due_date >= current_date and u.account_id is not null and u.amount > 0;

drop table upcoming_expenses;

-- list_categories shows which budgets are a percentage of income.
drop function categories_with_usage();
create function categories_with_usage()
returns table (
  id integer, name text, kind text, monthly_budget numeric, weekly_budget numeric,
  budget_percent numeric, tx_count integer
)
language sql stable as $$
  select c.id, c.name, c.kind, c.monthly_budget, c.weekly_budget, c.budget_percent, count(t.id)::int
  from categories c
  left join transactions t on t.category_id = c.id
  group by c.id
  order by c.kind, c.name
$$;

revoke execute on function categories_with_usage() from public, anon;
grant execute on function categories_with_usage() to authenticated;
