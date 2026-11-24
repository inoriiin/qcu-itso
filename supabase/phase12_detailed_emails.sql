-- ============================================================
-- QCU ITSO — Phase 12 detailed emails (run after phase11 —
-- uses notify_submission + defect_label)
-- submission_payload() now carries full filing details so every
-- notification email can render a details table. Status emails
-- move to an AFTER UPDATE trigger on submissions (final row
-- visible); the SER trigger is renamed so it fires first.
-- ============================================================

create or replace function submission_payload(p_submission uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'reference', s.reference_number,
    'title', s.title,
    'type', s.filing_type,
    'status', s.current_status,
    'student', st.full_name,
    'student_id', s.student_submitted_id_number,
    'college', c.name,
    'program', pr.name,
    'authors', (select string_agg(a.author_name, ', ' order by a.order_index)
                from submission_authors a where a.submission_id = s.id),
    'submitted', s.date_created::date,
    'filing_date', s.filing_date,
    'ser_deadline', (select p.deadline_date from problems p
                     where p.submission_id = s.id
                       and p.problem_type = 'Substantive Examination Request'
                       and p.status = 'open' limit 1)
  )
  from submissions s
  join students st on st.id = s.student_id
  join colleges c on c.id = s.college_id
  join programs pr on pr.id = s.program_id
  where s.id = p_submission
$$;

-- Status-change emails: AFTER UPDATE on submissions so the payload
-- reflects the final row. The SER trigger is renamed (a_ prefix) so
-- it runs first and ser_deadline is present in the payload.
drop trigger if exists trg_notify_status_change on status_history;
drop function if exists notify_status_change;
create or replace function notify_submission_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.current_status is distinct from old.current_status then
    if new.current_status = 'Approved with Certificate'
       and exists (select 1 from certificates c where c.submission_id = new.id) then
      return new;
    end if;
    perform notify_submission(new.id, 'status_change',
      submission_payload(new.id) || jsonb_build_object(
        'old', old.current_status,
        'new', new.current_status,
        'remark', (select r.comment_text from remarks r
                   where r.submission_id = new.id and r.with_status
                     and r.created_at > now() - interval '5 minutes'
                   order by r.created_at desc limit 1)));
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_submission_status on submissions;
create trigger trg_notify_submission_status after update on submissions
  for each row execute function notify_submission_status();

-- SER recompute (phase11 body; ser_started suppressed when the same
-- update also changed the status — that email already carries it)
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
    if old.current_status is not distinct from new.current_status then
      perform notify_submission(new.id, 'ser_started',
        submission_payload(new.id) || jsonb_build_object('deadline', v_deadline, 'updated', old.filing_date is not null));
      perform notify('admin', 'ser_started',
        submission_payload(new.id) || jsonb_build_object('deadline', v_deadline, 'updated', old.filing_date is not null));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_a_ser_on_filing on submissions;
create trigger trg_a_ser_on_filing after update on submissions
  for each row execute function maybe_create_ser();

-- Remarks written together with a status change ride along in the
-- status email instead of sending a second one.
alter table remarks add column if not exists with_status boolean not null default false;
create or replace function notify_remark() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.with_status then return new; end if;
  perform notify_submission(new.submission_id, 'remark',
    submission_payload(new.submission_id) || jsonb_build_object('text', left(new.comment_text, 1500)));
  return new;
end $$;

-- Certificate email carries the download link
create or replace function notify_certificate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_submission(new.submission_id, 'certificate',
    submission_payload(new.submission_id) || jsonb_build_object('certificate_link', new.file_reference, 'date_issued', new.date_issued));
  return new;
end $$;

-- Announcement RPC: the app calls this AFTER inserting authors so
-- the payload (and co-author recipients) are complete.
drop trigger if exists trg_notify_new_submission on submissions;
drop function if exists notify_new_submission;
create or replace function announce_submission(p_submission uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if submission_owner_email(p_submission) is distinct from auth_email() then
    raise exception 'Not authorized';
  end if;
  if exists (select 1 from notifications_log n
             where n.type = 'new_submission'
               and n.payload ->> 'reference' =
                   (select reference_number from submissions where id = p_submission)) then
    return;
  end if;
  perform notify('admin', 'new_submission', submission_payload(p_submission));
  perform notify_submission(p_submission, 'submission_received', submission_payload(p_submission));
end $$;
revoke execute on function announce_submission(uuid) from public, anon;
grant execute on function announce_submission(uuid) to authenticated;

-- Event notifications carry the full event details
create or replace function notify_new_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications_log (recipient, type, payload)
  select st.email, 'new_event',
    jsonb_build_object('event', new.title, 'activity_type', new.activity_type,
      'activity_other', new.activity_type_other, 'date', new.event_date, 'mode', new.mode_of_delivery,
      'duration_days', new.duration_days, 'duration_hours', new.duration_hours)
  from students st join authorized_emails a on a.email = st.email
  where a.status = 'active';
  return new;
end $$;

create or replace function notify_registration() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_name text;
  v_sid text;
  v_event jsonb;
begin
  select st.email, st.full_name, st.student_id_number into v_email, v_name, v_sid
    from students st where st.id = new.student_id;
  select jsonb_build_object('event', e.title, 'activity_type', e.activity_type,
      'activity_other', e.activity_type_other, 'date', e.event_date, 'mode', e.mode_of_delivery,
      'duration_days', e.duration_days, 'duration_hours', e.duration_hours,
      'student', v_name, 'student_id', v_sid)
    into v_event from events e where e.id = new.event_id;
  if tg_op = 'INSERT' then
    perform notify(v_email, 'registration_received', v_event);
    perform notify('admin', 'registration_request', v_event);
  elsif new.status is distinct from old.status then
    perform notify(v_email, 'registration_' || new.status::text, v_event);
  end if;
  return new;
end $$;

-- Deadline reminders with full payloads (dedupe keys unchanged)
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
    v_payload := submission_payload(r.submission_id) || jsonb_build_object(
      'problem_id', r.id, 'deadline', r.deadline_date, 'overdue', current_date > r.deadline_date);
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
      v_payload := submission_payload(r.submission_id) || jsonb_build_object(
        'defect_id', r.id, 'round', r.round_number, 'label', defect_label(r.round_number),
        'stage', v_stage, 'days_left', v_days, 'deadline', r.deadline_date, 'overdue', v_days < 0);
      insert into notifications_log (recipient, type, payload) values ('admin', 'defect_reminder', v_payload);
      perform notify_submission(r.submission_id, 'defect_reminder', v_payload);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $$;

notify pgrst, 'reload schema';
