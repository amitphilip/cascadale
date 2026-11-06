-- Tickets for Cas's background runs, so the app never holds an admin key.
--
-- Whatever triggers a run creates a ticket: a signed-in person when they change the plan
-- or ask for a refresh (as themselves, under row level security), or the akahu-sync edge
-- function after a sync. The ticket's id goes in the Inngest event. When the worker runs,
-- it hands the ticket to the cas-session edge function, which redeems it here and mints a
-- short session for the person who created it: never anyone else, so redeeming your own
-- ticket gets you nothing you couldn't already sign in as. A ticket is good for a few uses
-- (the run and its retries) within 30 minutes, longer than the debounce's 10 minute cap.

create table cas_tickets (
  id uuid primary key,
  -- the household the run is for
  user_id uuid not null default public.data_owner() references auth.users (id) on delete cascade,
  -- who the session is minted for: whoever created the ticket
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  uses_left integer not null default 3 check (uses_left >= 0),
  last_used_at timestamptz
);
create index cas_tickets_expires_idx on cas_tickets (expires_at);

-- People may create tickets for their own household, as themselves. There's no select,
-- update or delete policy: nobody reads or spends a ticket through the API.
alter table cas_tickets enable row level security;
create policy "create own tickets" on cas_tickets for insert to authenticated
  with check (user_id = (select public.data_owner()) and created_by = (select auth.uid()));

-- Spend one use of a ticket, if it's still good; returns who to mint the session for.
-- Only the service role (the cas-session edge function) can call it.
create function redeem_cas_ticket(p_ticket uuid)
returns table (household_id uuid, user_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.cas_tickets t
  set uses_left = t.uses_left - 1, last_used_at = now()
  where t.id = p_ticket and t.uses_left > 0 and t.expires_at > now()
  returning t.user_id, t.created_by
$$;
revoke execute on function redeem_cas_ticket(uuid) from public, anon, authenticated;
grant execute on function redeem_cas_ticket(uuid) to service_role;

-- Old tickets are only clutter: clear them out daily.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'cas-tickets-cleanup',
      '17 3 * * *',
      $job$delete from public.cas_tickets where expires_at < now() - interval '1 day'$job$
    );
  end if;
end;
$$;
