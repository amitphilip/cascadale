-- Budgets can be weekly as well as monthly. weekly_budget holds a weekly budget's own
-- amount; monthly_budget stays the monthly figure the plan, Cas and the reports read, and
-- for a weekly budget it's kept at the weekly amount's monthly equivalent (52 weeks over
-- 12 months), so nothing that reads monthly_budget has to know about weeks.

alter table categories
  add column weekly_budget numeric(14, 2) check (weekly_budget is null or weekly_budget > 0);

create function categories_budget_sync()
returns trigger
language plpgsql as $$
begin
  if new.weekly_budget is not null then
    new.monthly_budget := round(new.weekly_budget * 52 / 12);
  end if;
  return new;
end;
$$;

create trigger categories_budget_sync
  before insert or update on categories
  for each row execute function categories_budget_sync();

-- Set budgets on expense categories: each a month's amount unless its period is 'week'.
-- An amount of 0 clears the budget.
create or replace function set_category_budgets(p_budgets jsonb)
returns void
language sql as $$
  update categories c
  set weekly_budget = case
        when b.amount = 0 or coalesce(b.period, 'month') <> 'week' then null
        else round(b.amount, 2)
      end,
      monthly_budget = case when b.amount = 0 then null else round(b.amount) end
  from jsonb_to_recordset(p_budgets) as b (category_id integer, amount numeric, period text)
  where c.id = b.category_id and c.kind = 'expense'
$$;

drop function categories_with_usage();
create function categories_with_usage()
returns table (
  id integer, name text, kind text, monthly_budget numeric, weekly_budget numeric,
  tx_count integer
)
language sql stable as $$
  select c.id, c.name, c.kind, c.monthly_budget, c.weekly_budget, count(t.id)::int
  from categories c
  left join transactions t on t.category_id = c.id
  group by c.id
  order by c.kind, c.name
$$;

-- Money in and out over [p_start, p_end), transfers left out, optionally from some
-- accounts only: the Plan page's in and out for the month.
create function cashflow_between(p_start date, p_end date, p_accounts integer[] default null)
returns table (income numeric, expense numeric)
language sql stable as $$
  select coalesce(sum(t.amount) filter (where t.amount > 0), 0),
    coalesce(-sum(t.amount) filter (where t.amount < 0), 0)
  from transactions t
  left join categories c on c.id = t.category_id
  where coalesce(c.kind, '') <> 'transfer'
    and t.date >= p_start and t.date < p_end
    and (p_accounts is null or t.account_id = any (p_accounts))
$$;

revoke execute on function categories_with_usage(), cashflow_between(date, date, integer[])
  from public, anon;
grant execute on function categories_with_usage(), cashflow_between(date, date, integer[])
  to authenticated;
