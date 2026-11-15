-- pot_funded(t.id) ran once per transaction: Postgres can't inline a function with a
-- subquery, so each row paid for a function call and the row-level security on pot_entries
-- and plan_pots. Over the planner's averaging window that was most of a second. The same
-- check written into the query becomes one anti-join, with security checked once.

create or replace function category_spend(p_start date, p_end date)
returns table (id integer, name text, budget numeric, spent numeric)
language sql stable as $$
  select c.id, c.name, c.monthly_budget, -sum(t.amount) as spent
  from transactions t
  left join categories c on c.id = t.category_id
  where t.date >= p_start and t.date < p_end
    and (c.kind = 'expense' or (c.id is null and t.amount < 0))
    and not exists (
      select 1 from pot_entries e join plan_pots p on p.id = e.pot_id
      where e.transaction_id = t.id and e.kind = 'draw'
        and p.type = 'sinking_fund' and not p.removed
    )
  group by c.id, c.name, c.monthly_budget
  order by spent desc
$$;

create or replace function category_spend_for(p_start date, p_end date, p_accounts integer[])
returns table (id integer, name text, budget numeric, spent numeric)
language sql stable as $$
  select c.id, c.name, c.monthly_budget, -sum(t.amount) as spent
  from transactions t
  left join categories c on c.id = t.category_id
  where t.date >= p_start and t.date < p_end
    and t.account_id = any (p_accounts)
    and (c.kind = 'expense' or (c.id is null and t.amount < 0))
    and not exists (
      select 1 from pot_entries e join plan_pots p on p.id = e.pot_id
      where e.transaction_id = t.id and e.kind = 'draw'
        and p.type = 'sinking_fund' and not p.removed
    )
  group by c.id, c.name, c.monthly_budget
  order by spent desc
$$;

create or replace function plan_transactions(p_start date, p_end date)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.date, x.id), '[]')
  from (
    select t.id, t.date::text as date, t.account_id as "accountId", t.description, t.amount,
      t.category_id as "categoryId", c.kind as "categoryKind",
      t.rule_id as "ruleId", r.note as "ruleNote"
    from transactions t
    left join categories c on c.id = t.category_id
    left join rules r on r.id = t.rule_id
    where t.date >= p_start and t.date < p_end
      and not exists (
        select 1 from pot_entries e join plan_pots p on p.id = e.pot_id
        where e.transaction_id = t.id and e.kind = 'draw'
          and p.type = 'sinking_fund' and not p.removed
      )
  ) x
$$;
