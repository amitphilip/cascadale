-- Notes the app raises itself, such as a sync's to-do to categorize a merchant, carry a
-- ref so the next sync updates or resolves the same note instead of adding another.
alter table cas_notes add column ref text;
create unique index cas_notes_open_ref_idx on cas_notes (user_id, ref)
  where ref is not null and resolved_at is null;
