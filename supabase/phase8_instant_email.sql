-- ============================================================
-- QCU ITSO — instant email delivery (run once after phase7_email_cron.sql)
-- A trigger calls the send-notifications Edge Function as soon as
-- notifications are inserted. The 5-minute cron job stays as a backup.
-- Reuses the itso-email-dispatch cron command, so no secret is pasted here.
-- ============================================================

-- Atomically claim pending rows so concurrent runs never send the same email twice.
-- Rows stuck in 'sending' for 10+ minutes (crashed run) are reclaimed.
alter table notifications_log add column if not exists claimed_at timestamptz;

create or replace function claim_pending_notifications(p_limit integer default 50)
returns table (id uuid, recipient text, type text, payload jsonb)
language plpgsql security definer set search_path = public as $$
begin
  return query
  update notifications_log n set delivery_status = 'sending', claimed_at = now()
  where n.id in (
    select x.id from notifications_log x
    where x.delivery_status = 'pending'
       or (x.delivery_status = 'sending' and x.claimed_at < now() - interval '10 minutes')
    order by x.created_at
    limit p_limit
    for update skip locked
  )
  returning n.id, n.recipient, n.type, n.payload;
end $$;

revoke execute on function claim_pending_notifications(integer) from public, anon, authenticated;
grant execute on function claim_pending_notifications(integer) to service_role;

-- Fire the dispatcher once per INSERT statement (a new event notifying every
-- student is one statement -> one call). pg_net is async, so this never slows writes.
create or replace function dispatch_emails_now() returns trigger
language plpgsql security definer set search_path = public, cron as $$
declare
  v_cmd text;
begin
  select command into v_cmd from cron.job where jobname = 'itso-email-dispatch';
  if v_cmd is not null then execute v_cmd; end if;
  return null;
exception when others then
  return null; -- never block the insert; the 5-minute cron will pick it up
end $$;

revoke execute on function dispatch_emails_now() from public, anon, authenticated;

drop trigger if exists trg_dispatch_emails_now on notifications_log;
create trigger trg_dispatch_emails_now after insert on notifications_log
  for each statement execute function dispatch_emails_now();
