-- ============================================================
-- QCU ITSO — Phase 10 co-author emails
-- Optional email on submission_authors; status/remark/certificate/
-- defect notifications fan out to co-author emails via
-- notify_submission(). Recipients may not have accounts — the
-- email is informational only (no workspace link).
-- ============================================================

alter table submission_authors add column if not exists email text;

-- Normalize before write, then enforce the format on what remains.
create or replace function submission_author_email_normalize() returns trigger
language plpgsql as $$
begin
  new.email := nullif(lower(trim(new.email)), '');
  return new;
end $$;
drop trigger if exists trg_authors_email_norm on submission_authors;
create trigger trg_authors_email_norm before insert or update on submission_authors
  for each row execute function submission_author_email_normalize();

alter table submission_authors drop constraint if exists submission_authors_email_check;
alter table submission_authors add constraint submission_authors_email_check
  check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

-- Owner students may update authors (name/email) on their own active submissions.
drop policy if exists "authors student update" on submission_authors;
create policy "authors student update" on submission_authors for update to authenticated
  using (exists (select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id() and not s.archived))
  with check (exists (select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id() and not s.archived));

-- Notify owner + every distinct co-author email on a submission.
create or replace function notify_submission(p_submission uuid, p_type text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner text;
  v_email text;
begin
  v_owner := submission_owner_email(p_submission);
  perform notify(v_owner, p_type, p_payload);
  for v_email in
    select distinct a.email from submission_authors a
    where a.submission_id = p_submission and a.email is not null
      and (v_owner is null or lower(a.email) <> lower(v_owner))
  loop
    perform notify(v_email, p_type, p_payload || jsonb_build_object('coauthor', true));
  end loop;
end $$;
revoke execute on function notify_submission(uuid, text, jsonb) from public, anon, authenticated;

-- Re-create the per-event triggers to fan out to co-authors (payloads unchanged).
create or replace function notify_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_submission(new.submission_id, 'status_change',
    submission_payload(new.submission_id) || jsonb_build_object('old', new.old_status, 'new', new.new_status));
  return new;
end $$;

create or replace function notify_remark() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_submission(new.submission_id, 'remark',
    submission_payload(new.submission_id) || jsonb_build_object('text', left(new.comment_text, 200)));
  return new;
end $$;

create or replace function notify_certificate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_submission(new.submission_id, 'certificate', submission_payload(new.submission_id));
  return new;
end $$;

create or replace function notify_defect() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform notify_submission(new.submission_id, 'formality_defect',
    submission_payload(new.submission_id) || jsonb_build_object('round', new.round_number, 'deadline', new.deadline_date));
  return new;
end $$;

notify pgrst, 'reload schema';
