-- The change log (plan_changes) as an append-only record of every write through the shared
-- layer (lib/plan-service.ts): who made it, as which actor, why, and what it was before and
-- after. Two new actors: 'user' (a person approving one of Cas's proposals) and 'system'
-- (Cascadale itself, e.g. ticking off an action item a transaction shows is done).

do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('plan_changes', 'actor', false),
      ('plan_pots', 'updated_by', false),
      ('plan_adjustments', 'created_by', false),
      ('plan_adjustments', 'removed_by', true),
      ('plan_actions', 'created_by', false),
      ('plan_threads', 'made_by', true)
    ) as t(tbl, col, nullable)
  loop
    execute format('alter table %I drop constraint %I', c.tbl, c.tbl || '_' || c.col || '_check');
    execute format(
      'alter table %I add constraint %I check (%I in (''website'', ''mcp'', ''cas'', ''user'', ''system''))',
      c.tbl, c.tbl || '_' || c.col || '_check', c.col);
  end loop;
end;
$$;

alter table plan_changes
  -- the person who made it, when there was one (null for Cas's background runs and the system)
  add column changed_by uuid default auth.uid() references auth.users (id) on delete set null,
  -- what the change touched, before and after
  add column before jsonb,
  add column after jsonb,
  -- the transaction that showed an action item was done
  add column transaction_id integer references transactions (id) on delete set null;

create index plan_changes_latest_idx on plan_changes (user_id, id desc) where completed_at is not null;

-- A completed change is history: it can't be edited or deleted. A claimed one that's still
-- running can be completed, or dropped when its write fails so the operation id can be retried.
-- Foreign key actions (a deleted user or transaction) run as nested triggers and go through.
create function plan_changes_append_only()
returns trigger
language plpgsql
as $$
begin
  if old.completed_at is not null and pg_trigger_depth() = 1 then
    raise exception 'plan_changes is append-only: change % is already recorded', old.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger plan_changes_append_only
before update or delete on plan_changes
for each row execute function plan_changes_append_only();

-- Each Akahu sync run (every account of a household synced together) gets one id, so an
-- event and Cas's snapshot can name the run they came from.
alter table akahu_syncs add column run_id uuid;
create index akahu_syncs_run_idx on akahu_syncs (user_id, finished_at desc);
