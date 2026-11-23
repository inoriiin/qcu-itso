-- ============================================================
-- QCU ITSO — Phase 5 notifications (run once after fixup.sql)
-- In-app notification rows are created by triggers. delivery_status
-- stays 'pending' until the email Edge Function (Resend) is added.
-- recipient = student email, or 'admin' for the shared admin inbox.
-- ============================================================

alter table notifications_log add column if not exists read_at timestamptz;
create index if not exists notifications_log_recipient_idx on notifications_log (recipient, created_at desc);

create or replace function notify(p_recipient text, p_type text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_recipient is null or p_recipient = '' then return; end if;
  insert into notifications_log (recipient, type, payload) values (p_recipient, p_type, p_payload);
end $$;

create or replace function submission_owner_email(p_submission uuid) returns text
language sql stable security definer set search_path = public as $$
  select st.email from submissions s join students st on st.id = s.student_id where s.id = p_submission
$$;

create or replace function submission_payload(p_submission uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('reference', reference_number, 'title', title) from submissions where id = p_submission
$$;

-- New submission -> admin inbox
create or replace function notify_new_submission() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify('admin', 'new_submission', jsonb_build_object('reference', new.reference_number, 'title', new.title));
  return new;
end $$;
drop trigger if exists trg_notify_new_submission on submissions;
create trigger trg_notify_new_submission after insert on submissions
  for each row execute function notify_new_submission();

-- Status change -> student
create or replace function notify_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify(submission_owner_email(new.submission_id), 'status_change',
    submission_payload(new.submission_id) || jsonb_build_object('old', new.old_status, 'new', new.new_status));
  return new;
end $$;
drop trigger if exists trg_notify_status_change on status_history;
create trigger trg_notify_status_change after insert on status_history
  for each row execute function notify_status_change();

-- Remark -> student
create or replace function notify_remark() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify(submission_owner_email(new.submission_id), 'remark',
    submission_payload(new.submission_id) || jsonb_build_object('text', left(new.comment_text, 200)));
  return new;
end $$;
drop trigger if exists trg_notify_remark on remarks;
create trigger trg_notify_remark after insert on remarks
  for each row execute function notify_remark();

-- Certificate issued -> student
create or replace function notify_certificate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify(submission_owner_email(new.submission_id), 'certificate', submission_payload(new.submission_id));
  return new;
end $$;
drop trigger if exists trg_notify_certificate on certificates;
create trigger trg_notify_certificate after insert on certificates
  for each row execute function notify_certificate();

-- Formality defect logged -> student
create or replace function notify_defect() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify(submission_owner_email(new.submission_id), 'formality_defect',
    submission_payload(new.submission_id) || jsonb_build_object('round', new.round_number, 'deadline', new.deadline_date));
  return new;
end $$;
drop trigger if exists trg_notify_defect on formality_defects;
create trigger trg_notify_defect after insert on formality_defects
  for each row execute function notify_defect();

-- Event registration -> student confirmation + admin inbox; decision -> student
create or replace function notify_registration() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_name text;
  v_title text;
begin
  select email, full_name into v_email, v_name from students where id = new.student_id;
  select title into v_title from events where id = new.event_id;
  if tg_op = 'INSERT' then
    perform notify(v_email, 'registration_received', jsonb_build_object('event', v_title));
    perform notify('admin', 'registration_request', jsonb_build_object('event', v_title, 'student', v_name));
  elsif new.status is distinct from old.status then
    perform notify(v_email, 'registration_' || new.status::text, jsonb_build_object('event', v_title));
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_registration on event_registrations;
create trigger trg_notify_registration after insert or update of status on event_registrations
  for each row execute function notify_registration();

-- Read access: own inbox only (admins: the shared 'admin' inbox)
drop policy if exists "notifications select" on notifications_log;
create policy "notifications select" on notifications_log for select to authenticated
  using (recipient = auth_email() or (recipient = 'admin' and is_admin()));
create policy "notifications mark read" on notifications_log for update to authenticated
  using (recipient = auth_email() or (recipient = 'admin' and is_admin()))
  with check (recipient = auth_email() or (recipient = 'admin' and is_admin()));

revoke execute on function notify(text, text, jsonb) from public, anon, authenticated;
revoke execute on function submission_owner_email(uuid) from public, anon, authenticated;
revoke execute on function submission_payload(uuid) from public, anon, authenticated;
