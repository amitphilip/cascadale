-- A discrepancy: Claude saw something in the raw data that disagrees with Cas's snapshot
-- (report_discrepancy). Cas checks it on its next run and resolves the note once reconciled.

alter table cas_notes drop constraint cas_notes_kind_check;
alter table cas_notes add constraint cas_notes_kind_check
  check (kind in ('observation', 'decision', 'preference', 'todo', 'discrepancy'));
