-- ============================================================
-- QCU ITSO — Phase 6 + 3.7 scheduled jobs (run once after phase4_profiles.sql)
-- Requires the pg_cron extension (Database → Extensions → pg_cron → enable),
-- or the create extension line below.
--
-- Daily at 01:00 UTC (09:00 Philippine time):
--   • SER reminders: once a submission is within 1 month of its 18-month
--     deadline, remind admins monthly until the SER is marked handled
--   • Formality defect reminders: within 1 month of the 2-month deadline,
--     remind admins monthly until the round is resolved
--   • Auto-archive: 10 years after completion_date, or 10 years of no activity
-- ============================================================

create extension if not exists pg_cron;

-- last_activity_date must move on remarks + defect actions, not only status changes
create or replace function bump_submission_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_sub uuid;
begin
  if tg_table_name = 'formality_defect_comments' then
    select submission_id into v_sub from formality_defects where id = new.formality_defect_id;
  else
    v_sub := new.submission_id;
  end if;
  update submissions set last_activity_date = now() where id = v_sub;
  return new;
end $$;

drop trigger if exists trg_activity_remarks on remarks;
create trigger trg_activity_remarks after insert on remarks
  for each row execute function bump_submission_activity();
drop trigger if exists trg_activity_defects on formality_defects;
create trigger trg_activity_defects after insert or update of status on formality_defects
  for each row execute function bump_submission_activity();
drop trigger if exists trg_activity_defect_comments on formality_defect_comments;
create trigger trg_activity_defect_comments after insert on formality_defect_comments
  for each row execute function bump_submission_activity();

-- Reminders. "Monthly" = no reminder for this record in the last month.
create or replace function send_deadline_reminders() returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select p.id, p.deadline_date, s.reference_number, s.title
    from problems p join submissions s on s.id = p.submission_id
    where p.problem_type = 'Substantive Examination Request'
      and p.status = 'open' and not s.archived
      and current_date >= (p.deadline_date - interval '1 month')::date
      and not exists (
        select 1 from notifications_log n
        where n.type = 'ser_reminder' and n.payload ->> 'problem_id' = p.id::text
          and n.created_at > now() - interval '1 month')
  loop
    insert into notifications_log (recipient, type, payload) values ('admin', 'ser_reminder',
      jsonb_build_object('problem_id', r.id, 'reference', r.reference_number, 'title', r.title,
        'deadline', r.deadline_date, 'overdue', current_date > r.deadline_date));
    v_count := v_count + 1;
  end loop;

  for r in
    select d.id, d.deadline_date, d.round_number, s.reference_number, s.title
    from formality_defects d join submissions s on s.id = d.submission_id
    where d.status = 'open' and not s.archived
      and current_date >= (d.deadline_date - interval '1 month')::date
      and not exists (
        select 1 from notifications_log n
        where n.type = 'defect_reminder' and n.payload ->> 'defect_id' = d.id::text
          and n.created_at > now() - interval '1 month')
  loop
    insert into notifications_log (recipient, type, payload) values ('admin', 'defect_reminder',
      jsonb_build_object('defect_id', r.id, 'reference', r.reference_number, 'title', r.title,
        'round', r.round_number, 'deadline', r.deadline_date, 'overdue', current_date > r.deadline_date));
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- Automatic 10-year archiving (no admin review step, per spec 3.7)
create or replace function auto_archive_submissions() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  with moved as (
    update submissions set
      archived = true,
      archived_date = now(),
      archive_reason = case
        when completion_date is not null and completion_date <= (current_date - interval '10 years')::date
          then 'Completion-based (10 years after completion)'
        else 'Inactivity-based (10 years without activity)'
      end
    where not archived
      and ((completion_date is not null and completion_date <= (current_date - interval '10 years')::date)
        or last_activity_date <= now() - interval '10 years')
    returning id, reference_number, archive_reason
  )
  insert into admin_action_log (admin_email, action_type, target_record, details)
  select 'system', 'auto_archive', reference_number, jsonb_build_object('reason', archive_reason)
  from moved;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function itso_daily_jobs() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform send_deadline_reminders();
  perform auto_archive_submissions();
end $$;

revoke execute on function bump_submission_activity() from public, anon, authenticated;
revoke execute on function send_deadline_reminders() from public, anon, authenticated;
revoke execute on function auto_archive_submissions() from public, anon, authenticated;
revoke execute on function itso_daily_jobs() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'itso-daily';
select cron.schedule('itso-daily', '0 1 * * *', 'select public.itso_daily_jobs()');
