-- Checks the access rules on Cas's tickets (20261108000000_cas_tickets.sql). Run against a
-- local or branch database, never production: psql "$DATABASE_URL" -f supabase/checks/cas_tickets.sql
-- Everything happens in a transaction that's rolled back; any failure raises an error.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'member@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'stranger@example.test');
insert into household_members (member_id, owner_id)
values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a');

-- a member creates a ticket as themselves, for the household
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
insert into cas_tickets (id, reason) values ('11111111-1111-1111-1111-111111111111', 'check');

do $$
begin
  assert (select count(*) from cas_tickets) = 0, 'tickets must not be readable through the API';

  begin
    insert into cas_tickets (id, created_by) values (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: a member made a ticket for the owner';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from redeem_cas_ticket('11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL: a signed-in user redeemed a ticket';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- a stranger can't make tickets for someone else's household
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', true);
do $$
begin
  insert into cas_tickets (id, user_id) values (gen_random_uuid(), '00000000-0000-0000-0000-00000000000a');
  raise exception 'FAIL: a stranger made a ticket for another household';
exception when insufficient_privilege then null;
end;
$$;

-- the service role redeems it: for the household, as the member who made it, three times
reset role;
set local role service_role;
do $$
declare
  r record;
begin
  for i in 1..3 loop
    select * into r from redeem_cas_ticket('11111111-1111-1111-1111-111111111111');
    assert r.household_id = '00000000-0000-0000-0000-00000000000a', 'household should be the owner';
    assert r.user_id = '00000000-0000-0000-0000-00000000000b', 'session should be for the ticket''s creator';
  end loop;
  assert not exists (select 1 from redeem_cas_ticket('11111111-1111-1111-1111-111111111111')),
    'a spent ticket must not redeem';
  assert not exists (select 1 from redeem_cas_ticket(gen_random_uuid())), 'an unknown ticket must not redeem';
end;
$$;

reset role;
insert into cas_tickets (id, user_id, created_by, expires_at) values
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-00000000000a', now() - interval '1 minute');
set local role service_role;
do $$
begin
  assert not exists (select 1 from redeem_cas_ticket('22222222-2222-2222-2222-222222222222')),
    'an expired ticket must not redeem';
end;
$$;

\echo 'cas_tickets: all checks passed'
rollback;
