-- A budget can be a percentage of projected income instead of a fixed amount.
-- budget_percent holds the percentage; monthly_budget (and weekly_budget for a weekly one)
-- stay the amount it works out to, so everything that reads them is unchanged. The app
-- works out projected income (lib/budget-percent.ts) and re-sets the amounts when it moves.

alter table categories
  add column budget_percent numeric(5, 2)
    check (budget_percent is null or (budget_percent > 0 and budget_percent <= 100));

-- Set budgets on expense categories: each a month's amount unless its period is 'week'.
-- An amount of 0 clears the budget. With a percent, the amount is what that percent of
-- projected income comes to; without one, the budget is a fixed amount.
create or replace function set_category_budgets(p_budgets jsonb)
returns void
language sql as $$
  update categories c
  set weekly_budget = case
        when b.amount = 0 or coalesce(b.period, 'month') <> 'week' then null
        else round(b.amount, 2)
      end,
      monthly_budget = case when b.amount = 0 then null else round(b.amount) end,
      budget_percent = case when b.amount = 0 then null else b.percent end
  from jsonb_to_recordset(p_budgets) as b (
    category_id integer, amount numeric, period text, percent numeric
  )
  where c.id = b.category_id and c.kind = 'expense'
$$;
