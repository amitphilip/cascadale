-- Sync Akahu bank feeds every hour by calling the akahu-sync edge function.
--
-- The call reads two Vault secrets; create them once in the SQL editor:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as the function''s AKAHU_CRON_SECRET>', 'akahu_cron_secret');
-- Until they exist the job runs but makes no request. Runs are logged in cron.job_run_details,
-- responses in net._http_response.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'akahu-sync',
  '7 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
      || '/functions/v1/akahu-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'akahu_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'project_url')
    and exists (select 1 from vault.decrypted_secrets where name = 'akahu_cron_secret')
  $$
);
