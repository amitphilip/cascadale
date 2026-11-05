-- Cas adds action items from the Plan page's chat, so they can say it was Cas.

alter table plan_actions drop constraint plan_actions_created_by_check;
alter table plan_actions add constraint plan_actions_created_by_check
  check (created_by in ('website', 'mcp', 'cas'));
