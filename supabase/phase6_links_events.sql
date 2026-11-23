-- ============================================================
-- QCU ITSO — Broken Drive link reporting + new-event announcements
-- (run once after phase5_scheduled_jobs.sql)
-- ============================================================

alter table submissions
  add column if not exists drive_link_reported_at timestamptz,
  add column if not exists drive_link_report_note text,
  add column if not exists drive_link_reported_by text;

-- Owner student or any admin can flag a submission's Drive link as broken/inaccessible.
-- Admins are notified; if an admin reports it, the owner student is notified too.
create or replace function report_broken_link(p_submission uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner text := submission_owner_email(p_submission);
begin
  if not (is_admin() or v_owner = auth_email()) then raise exception 'Not authorized'; end if;
  update submissions set
    drive_link_reported_at = now(),
    drive_link_report_note = nullif(left(trim(coalesce(p_note, '')), 300), ''),
    drive_link_reported_by = auth_email(),
    last_activity_date = now()
  where id = p_submission;
  perform notify('admin', 'broken_link',
    submission_payload(p_submission) || jsonb_build_object('note', p_note, 'by', auth_email()));
  if is_admin() then
    perform notify(v_owner, 'broken_link',
      submission_payload(p_submission) || jsonb_build_object('note', p_note, 'by', 'ITSO'));
  end if;
end $$;

-- Owner student replaces the Drive folder link; clears any broken-link flag.
create or replace function update_my_drive_link(p_submission uuid, p_link text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if submission_owner_email(p_submission) is distinct from auth_email() then
    raise exception 'Not authorized';
  end if;
  if p_link is null or trim(p_link) !~ '^https://' then
    raise exception 'Drive link must start with https://';
  end if;
  update submissions set
    drive_folder_link = trim(p_link),
    drive_link_reported_at = null, drive_link_report_note = null, drive_link_reported_by = null,
    last_activity_date = now()
  where id = p_submission and not archived;
  perform notify('admin', 'drive_link_updated', submission_payload(p_submission));
end $$;

-- Admins clear a report after confirming access works.
create or replace function clear_broken_link(p_submission uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  update submissions set drive_link_reported_at = null, drive_link_report_note = null, drive_link_reported_by = null
  where id = p_submission;
end $$;

-- New event -> announcement to every active student
create or replace function notify_new_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications_log (recipient, type, payload)
  select st.email, 'new_event',
    jsonb_build_object('event', new.title, 'date', new.event_date, 'mode', new.mode_of_delivery)
  from students st join authorized_emails a on a.email = st.email
  where a.status = 'active';
  return new;
end $$;
drop trigger if exists trg_notify_new_event on events;
create trigger trg_notify_new_event after insert on events
  for each row execute function notify_new_event();

grant execute on function report_broken_link(uuid, text) to authenticated;
grant execute on function update_my_drive_link(uuid, text) to authenticated;
grant execute on function clear_broken_link(uuid) to authenticated;
revoke execute on function report_broken_link(uuid, text) from anon;
revoke execute on function update_my_drive_link(uuid, text) from anon;
revoke execute on function clear_broken_link(uuid) from anon;
revoke execute on function notify_new_event() from public, anon, authenticated;
