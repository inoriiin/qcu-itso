-- ============================================================
-- QCU ITSO — schedule the send-notifications Edge Function
-- (run once after phase6_links_events.sql)
--
-- Requires: pg_net extension (Database → Extensions → pg_net → enable)
-- Before running, replace YOUR-CRON-SECRET below with the value in
-- supabase/cron_secret.local.txt (the same value saved as the
-- CRON_SECRET Edge Function secret). Keep it private.
-- ============================================================

create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'itso-email-dispatch';
select cron.schedule(
  'itso-email-dispatch',
  '*/5 * * * *',  -- every 5 minutes
  $$
  select net.http_post(
    url := 'https://nzdjmjxcjlivjzqkxmdc.supabase.co/functions/v1/send-notifications',
    headers := '{"x-cron-secret": "YOUR-CRON-SECRET", "Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
