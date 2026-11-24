-- ============================================================
-- QCU ITSO — Phase 11 filing deadlines (run after phase10 —
-- uses notify_submission for co-author fan-out)
-- "Paper Submitted" enum value is deprecated (kept for history);
-- new submissions start at 'Under Review'. Filing date defaults
-- when status hits 'Submitted to IPOPHIL'; SER recomputes on any
-- filing_date change; defects get labels, details and 60 days.
-- ============================================================

alter table submissions alter column current_status set default 'Under Review';
alter table submissions disable trigger trg_status_change;
update submissions set current_status = 'Under Review' where current_status = 'Paper Submitted';
alter table submissions enable trigger trg_status_change;

-- Default filing date the moment status becomes 'Submitted to IPOPHIL'
create or replace function default_filing_date() returns trigger
language plpgsql as $$
begin
  if new.current_status = 'Submitted to IPOPHIL'
     and old.current_status is distinct from new.current_status
     and new.filing_date is null then
    new.filing_date := (now() at time zone 'Asia/Manila')::date;
  end if;
  return new;
end $$;
drop trigger if exists trg_default_filing_date on submissions;
create trigger trg_default_filing_date before update on submissions
  for each row execute function default_filing_date();

-- SER clock follows any filing_date change (must be AFTER UPDATE,
-- not UPDATE OF filing_date — the column is also set by a BEFORE trigger)
drop trigger if exists trg_ser_on_filing on submissions;
create or replace function maybe_create_ser() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_deadline date;
begin
  if new.filing_date is distinct from old.filing_date and new.filing_date is not null then
    v_deadline := (new.filing_date + interval '18 months')::date;
    update problems set date_triggered = new.filing_date, deadline_date = v_deadline
      where submission_id = new.id and problem_type = 'Substantive Examination Request' and status = 'open';
    if not found and not exists (select 1 from problems
        where submission_id = new.id and problem_type = 'Substantive Examination Request') then
      insert into problems (submission_id, problem_type, date_triggered, deadline_date)
      values (new.id, 'Substantive Examination Request', new.filing_date, v_deadline);
    end if;
    perform notify_submission(new.id, 'ser_started',
      submission_payload(new.id) || jsonb_build_object('filing_date', new.filing_date, 'deadline', v_deadline, 'updated', old.filing_date is not null));
    perform notify('admin', 'ser_started',
      submission_payload(new.id) || jsonb_build_object('filing_date', new.filing_date, 'deadline', v_deadline, 'updated', old.filing_date is not null));
  end if;
  return new;
end $$;
create trigger trg_ser_on_filing
  after update on submissions
  for each row execute function maybe_create_ser();

-- Formality defects never apply to Copyright filings
create or replace function reject_copyright_defect() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'problems' and new.problem_type is distinct from 'Formality Defect' then
    return new;
  end if;
  if (select filing_type from submissions where id = new.submission_id) = 'Copyright' then
    raise exception 'Formality defects do not apply to Copyright submissions';
  end if;
  return new;
end $$;
drop trigger if exists trg_no_copyright_defect on formality_defects;
create trigger trg_no_copyright_defect before insert on formality_defects
  for each row execute function reject_copyright_defect();
drop trigger if exists trg_no_copyright_defect_prob on problems;
create trigger trg_no_copyright_defect_prob before insert on problems
  for each row execute function reject_copyright_defect();

-- Defect deadline = notice_date + 60 days (was 2 months); fix open rows too
create or replace function set_defect_deadline() returns trigger
language plpgsql as $$
begin
  new.deadline_date := new.notice_date + 60;
  return new;
end $$;
update formality_defects set deadline_date = notice_date + 60 where status = 'open';
update problems p set deadline_date = d.notice_date + 60
  from formality_defects d
  where d.problem_id = p.id and p.problem_type = 'Formality Defect' and p.status = 'open' and d.status = 'open';

alter table formality_defects add column if not exists details text;

-- "1st Formality Defect", "2nd …", "11th/12th/13th" handled
create or replace function defect_label(p_round int) returns text
language sql immutable as $$
  select case
    when p_round % 100 between 11 and 13 then p_round || 'th'
    when p_round % 10 = 1 then p_round || 'st'
    when p_round % 10 = 2 then p_round || 'nd'
    when p_round % 10 = 3 then p_round || 'rd'
    else p_round || 'th' end || ' Formality Defect'
$$;
revoke execute on function defect_label(int) from public, anon, authenticated;

-- Defect notification now carries label/notice/details/60-day window
create or replace function notify_defect() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_submission(new.submission_id, 'formality_defect',
    submission_payload(new.submission_id) || jsonb_build_object(
      'round', new.round_number,
      'label', defect_label(new.round_number),
      'notice_date', new.notice_date,
      'details', left(coalesce(new.details, ''), 1500),
      'days', 60,
      'deadline', new.deadline_date));
  return new;
end $$;

-- Reminders: SER monthly to admin + owner/co-authors; defects at
-- 30d / 7d / due stages (each stage once, most urgent only per run)
create or replace function send_deadline_reminders() returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_count integer := 0;
  v_days integer;
  v_stage text;
  v_payload jsonb;
begin
  for r in
    select p.id, p.submission_id, p.deadline_date, s.reference_number, s.title
    from problems p join submissions s on s.id = p.submission_id
    where p.problem_type = 'Substantive Examination Request'
      and p.status = 'open' and not s.archived
      and current_date >= (p.deadline_date - interval '1 month')::date
      and not exists (
        select 1 from notifications_log n
        where n.type = 'ser_reminder' and n.payload ->> 'problem_id' = p.id::text
          and n.created_at > now() - interval '1 month')
  loop
    v_payload := jsonb_build_object('problem_id', r.id, 'reference', r.reference_number, 'title', r.title,
      'deadline', r.deadline_date, 'overdue', current_date > r.deadline_date);
    insert into notifications_log (recipient, type, payload) values ('admin', 'ser_reminder', v_payload);
    perform notify_submission(r.submission_id, 'ser_reminder', v_payload);
    v_count := v_count + 1;
  end loop;

  for r in
    select d.id, d.submission_id, d.deadline_date, d.round_number, s.reference_number, s.title
    from formality_defects d join submissions s on s.id = d.submission_id
    where d.status = 'open' and not s.archived
      and d.deadline_date - current_date <= 30
  loop
    v_days := r.deadline_date - current_date;
    v_stage := case when v_days <= 0 then 'due' when v_days <= 7 then '7d' else '30d' end;
    if not exists (
      select 1 from notifications_log n
      where n.type = 'defect_reminder' and n.payload ->> 'defect_id' = r.id::text
        and n.payload ->> 'stage' = v_stage) then
      v_payload := jsonb_build_object('defect_id', r.id, 'reference', r.reference_number, 'title', r.title,
        'round', r.round_number, 'label', defect_label(r.round_number), 'stage', v_stage,
        'days_left', v_days, 'deadline', r.deadline_date, 'overdue', v_days < 0);
      insert into notifications_log (recipient, type, payload) values ('admin', 'defect_reminder', v_payload);
      perform notify_submission(r.submission_id, 'defect_reminder', v_payload);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $$;

notify pgrst, 'reload schema';
