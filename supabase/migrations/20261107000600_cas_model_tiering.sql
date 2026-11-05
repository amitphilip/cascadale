-- Model tiering for Cas: each snapshot records which tier ran it and whether the model
-- said it couldn't give a confident read, which escalates the next run.

alter table cas_snapshots
  add column tier text check (tier in ('default', 'escalate', 'deep')),
  add column uncertain boolean not null default false;
