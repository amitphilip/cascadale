-- The account number a statement names (in its header lines or file name), so the
-- akahu-sync edge function can tell which of your accounts an Akahu account already is.

alter table statements add column account_number text;

create or replace function import_statement(p_statement jsonb, p_rows jsonb)
returns table (inserted integer, categorized integer)
language plpgsql as $$
declare
  v_id integer;
  v_inserted integer;
  v_categorized integer;
begin
  insert into statements (
    account_id, file_name, stored_name, row_count, period_start, period_end, account_number
  )
  values (
    (p_statement ->> 'account_id')::integer,
    p_statement ->> 'file_name',
    p_statement ->> 'stored_name',
    (p_statement ->> 'row_count')::integer,
    (p_statement ->> 'period_start')::date,
    (p_statement ->> 'period_end')::date,
    p_statement ->> 'account_number'
  )
  returning statements.id into v_id;

  with ins as (
    insert into transactions (
      account_id, statement_id, date, description, amount, category_id, rule_id,
      category_source, category_confidence, source, hash
    )
    select r.account_id, v_id, r.date, r.description, r.amount, r.category_id, r.rule_id,
      r.category_source, r.category_confidence, 'import', r.hash
    from jsonb_to_recordset(p_rows) as r (
      account_id integer, date date, description text, amount numeric, category_id integer,
      rule_id integer, category_source text, category_confidence integer, hash text
    )
    on conflict (account_id, hash) do nothing
    returning transactions.category_id
  )
  select count(*)::integer, count(ins.category_id)::integer into v_inserted, v_categorized
  from ins;

  if v_inserted = 0 then
    delete from statements where statements.id = v_id;
  else
    update statements set inserted_count = v_inserted where statements.id = v_id;
  end if;
  return query select v_inserted, v_categorized;
end;
$$;
