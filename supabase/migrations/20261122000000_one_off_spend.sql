-- A transaction linked to a one-off payment is paid for by that one-off's money, not out of
-- a budget: leave it out of category spending (budgets, the Overview) and of the plan's
-- averaging window, the way sinking-fund draws already are. Linking the AOC payment to its
-- one-off kept it in Other Expense because these only knew about pot_entries.

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
    and not exists (select 1 from one_off_transactions o where o.transaction_id = t.id)
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
    and not exists (select 1 from one_off_transactions o where o.transaction_id = t.id)
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
      and not exists (select 1 from one_off_transactions o where o.transaction_id = t.id)
  ) x
$$;

-- The checks above look links up by transaction alone; the primary key leads with user_id.
create index if not exists one_off_transactions_transaction_id_idx
  on one_off_transactions (transaction_id);
