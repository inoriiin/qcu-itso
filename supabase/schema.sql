-- ============================================================
-- QCU ITSO — Phase 0 Foundation Schema (Supabase / Postgres)
-- Run this entire file once in the Supabase SQL Editor.
-- ============================================================

-- ---------- Enums ----------
create type user_role as enum ('student', 'admin', 'super_admin');
create type account_status as enum ('active', 'inactive');
create type filing_type as enum ('Copyright', 'Patent', 'Utility Model', 'Industrial Design');
create type submission_status as enum (
  'Paper Submitted', 'Under Review', 'Submitted to IPOPHIL', 'Revisions Needed',
  'Passed', 'Received eSOA', 'Paid', 'Approved with Certificate',
  'Withdrawn', 'Disapproved'
);
create type problem_type as enum ('Substantive Examination Request', 'Formality Defect');
create type problem_status as enum ('open', 'resolved');
create type event_activity_type as enum (
  'IP Awareness', 'Patent Search', 'Patent Drafting',
  'IPA and PS', 'IPA and PD', 'PS and PD', 'IPS, PA, and PD', 'Others'
);
create type event_mode as enum ('Onsite', 'Online');
create type registration_status as enum ('pending', 'approved', 'declined');

-- ---------- Reference tables ----------
create table colleges (
  id smallint generated always as identity primary key,
  name text not null unique
);

create table programs (
  id smallint generated always as identity primary key,
  college_id smallint not null references colleges(id),
  name text not null,
  unique (college_id, name)
);

insert into colleges (name) values
  ('College of Business'),
  ('College of Accountancy'),
  ('College of Education'),
  ('College of Engineering'),
  ('College of Computer Studies');

insert into programs (college_id, name)
select c.id, p.name
from colleges c
join (values
  ('College of Business',        'Bachelor of Science in Entrepreneurship (BSentrep)'),
  ('College of Accountancy',     'Bachelor of Science in Accountancy (BSA)'),
  ('College of Education',       'Bachelor of Early Childhood Education (BECEd)'),
  ('College of Engineering',     'BS Industrial Engineering (BSIE)'),
  ('College of Engineering',     'BS Electronics Engineering (BSECE)'),
  ('College of Engineering',     'BS Computer Engineering (BSCpE)'),
  ('College of Computer Studies','BS Information Technology (BSIT)'),
  ('College of Computer Studies','BS Information Systems (BSIS)'),
  ('College of Computer Studies','BS Computer Science (BSCS)')
) as p(college_name, name) on p.college_name = c.name;

-- ---------- Auth / whitelist ----------
create table authorized_emails (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(trim(email))),
  role user_role not null default 'student',
  status account_status not null default 'active',
  added_by uuid,
  date_added timestamptz not null default now()
);

create table students (
  id uuid primary key default gen_random_uuid(),
  email text not null unique references authorized_emails(email),
  full_name text not null,
  student_id_number text not null check (student_id_number ~ '^\d{2}-\d{4}$'),
  college_id smallint references colleges(id),
  program_id smallint references programs(id),
  date_joined timestamptz not null default now()
);

create table admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique references authorized_emails(email),
  full_name text not null,
  role user_role not null check (role in ('admin', 'super_admin'))
);

-- ---------- Submissions ----------
create sequence if not exists submission_ref_seq;

create table submissions (
  id uuid primary key default gen_random_uuid(),
  reference_number text unique,
  student_id uuid not null references students(id),
  student_submitted_id_number text not null,
  title text not null,
  program_id smallint not null references programs(id),
  college_id smallint not null references colleges(id),
  filing_type filing_type not null,
  current_status submission_status not null default 'Paper Submitted',
  filing_date date,
  drive_folder_link text,
  date_created timestamptz not null default now(),
  completion_date date,
  last_activity_date timestamptz not null default now(),
  archived boolean not null default false,
  archived_date timestamptz,
  archive_reason text
);
create index on submissions (student_id);
create index on submissions (college_id);
create index on submissions (current_status);
create index on submissions (archived);

create or replace function set_reference_number() returns trigger
language plpgsql as $$
begin
  if new.reference_number is null or new.reference_number = '' then
    new.reference_number := 'ITSO-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('submission_ref_seq')::text, 4, '0');
  end if;
  return new;
end $$;

create trigger trg_submission_ref
  before insert on submissions
  for each row execute function set_reference_number();

create table submission_authors (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  author_name text not null,
  order_index smallint not null,
  added_by_role user_role not null
);
create index on submission_authors (submission_id);

create table status_history (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  old_status submission_status,
  new_status submission_status not null,
  changed_by_email text,
  created_at timestamptz not null default now()
);
create index on status_history (submission_id);

create table remarks (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  admin_email text,
  comment_text text not null,
  created_at timestamptz not null default now()
);
create index on remarks (submission_id);

create table certificates (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references submissions(id) on delete cascade,
  file_reference text,
  issued_by uuid,
  date_issued timestamptz not null default now()
);

-- ---------- Problems layer (separate from status) ----------
create table problems (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  problem_type problem_type not null,
  date_triggered date not null default current_date,
  deadline_date date not null,
  status problem_status not null default 'open',
  resolved_date date,
  resolved_by uuid,
  resolution_note text
);
create index on problems (submission_id);
create index on problems (status);

create table formality_defects (
  id uuid primary key default gen_random_uuid(),
  problem_id uuid not null references problems(id) on delete cascade,
  submission_id uuid not null references submissions(id) on delete cascade,
  round_number smallint not null,
  notice_date date not null,
  deadline_date date not null,
  status problem_status not null default 'open',
  resolved_date date,
  resolved_by uuid
);
create index on formality_defects (submission_id);

create table formality_defect_comments (
  id uuid primary key default gen_random_uuid(),
  formality_defect_id uuid not null references formality_defects(id) on delete cascade,
  admin_email text,
  comment_text text not null,
  created_at timestamptz not null default now()
);
create index on formality_defect_comments (formality_defect_id);

-- ---------- Notifications / audit ----------
create table notifications_log (
  id uuid primary key default gen_random_uuid(),
  recipient text not null,
  type text not null,
  payload jsonb,
  created_at timestamptz not null default now(),
  delivery_status text not null default 'pending'
);

create table admin_action_log (
  id uuid primary key default gen_random_uuid(),
  admin_email text,
  action_type text not null,
  target_record text,
  details jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Events ----------
create table events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  activity_type event_activity_type not null,
  activity_type_other text,
  mode_of_delivery event_mode not null,
  event_date date not null,
  duration_days smallint not null default 1,
  duration_hours numeric not null default 8,
  participants_involved text[] not null default '{}',
  sector text[] not null default '{}',
  participants_male integer not null default 0,
  participants_female integer not null default 0,
  participants_total integer not null default 0,
  age_range text[] not null default '{}',
  drive_link text,
  created_by uuid,
  date_created timestamptz not null default now()
);

create table event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  registration_date timestamptz not null default now(),
  status registration_status not null default 'pending',
  unique (event_id, student_id)
);
create index on event_registrations (event_id);

-- ============================================================
-- Auth helpers — resolve the caller's email + whitelist role
-- ============================================================
create or replace function auth_email() returns text
language sql stable security definer set search_path = public as $$
  select lower(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'email',
    ''
  ))
$$;

create or replace function my_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from authorized_emails
  where email = auth_email() and status = 'active'
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() in ('admin', 'super_admin'), false)
$$;

create or replace function is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() = 'super_admin', false)
$$;

create or replace function my_student_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from students where email = auth_email()
$$;

create or replace function log_admin_action(p_action text, p_target text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into admin_action_log (admin_email, action_type, target_record, details)
  values (auth_email(), p_action, p_target, p_details);
end $$;

-- ============================================================
-- Triggers
-- ============================================================

-- Status changes: append to status_history + bump last_activity_date;
-- terminal states stamp completion_date (drives the 10-year archive rule)
create or replace function log_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.current_status is distinct from old.current_status then
    insert into status_history (submission_id, old_status, new_status, changed_by_email)
    values (new.id, old.current_status, new.current_status, auth_email());
    new.last_activity_date := now();
    if new.current_status in ('Approved with Certificate', 'Withdrawn', 'Disapproved')
       and old.current_status not in ('Approved with Certificate', 'Withdrawn', 'Disapproved') then
      new.completion_date := current_date;
    end if;
  end if;
  return new;
end $$;

create trigger trg_status_change
  before update on submissions
  for each row execute function log_status_change();

-- SER problem auto-created the moment filing_date is recorded (18-month clock)
create or replace function maybe_create_ser() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.filing_date is not null and old.filing_date is null then
    insert into problems (submission_id, problem_type, date_triggered, deadline_date)
    values (new.id, 'Substantive Examination Request', new.filing_date,
            (new.filing_date + interval '18 months')::date);
  end if;
  return new;
end $$;

create trigger trg_ser_on_filing
  after update of filing_date on submissions
  for each row execute function maybe_create_ser();

-- Formality defect deadline = notice_date + 2 months (always recomputed)
create or replace function set_defect_deadline() returns trigger
language plpgsql as $$
begin
  new.deadline_date := (new.notice_date + interval '2 months')::date;
  return new;
end $$;

create trigger trg_defect_deadline
  before insert or update of notice_date on formality_defects
  for each row execute function set_defect_deadline();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table authorized_emails enable row level security;
alter table students enable row level security;
alter table admins enable row level security;
alter table colleges enable row level security;
alter table programs enable row level security;
alter table submissions enable row level security;
alter table submission_authors enable row level security;
alter table status_history enable row level security;
alter table remarks enable row level security;
alter table certificates enable row level security;
alter table problems enable row level security;
alter table formality_defects enable row level security;
alter table formality_defect_comments enable row level security;
alter table notifications_log enable row level security;
alter table admin_action_log enable row level security;
alter table events enable row level security;
alter table event_registrations enable row level security;

-- Reference data: readable by any authenticated user
create policy "ref read" on colleges for select to authenticated using (true);
create policy "ref read" on programs for select to authenticated using (true);

-- Whitelist: members read own row, admins read all; only super_admin writes
create policy "whitelist select" on authorized_emails for select to authenticated
  using (email = auth_email() or is_admin());
create policy "whitelist superadmin write" on authorized_emails for all to authenticated
  using (is_super_admin()) with check (is_super_admin());

-- Students: own profile for self, all for admins
create policy "students select" on students for select to authenticated
  using (email = auth_email() or is_admin());
create policy "students admin write" on students for all to authenticated
  using (is_admin()) with check (is_admin());

-- Admin profiles: self + admins read; super_admin manages
create policy "admins select" on admins for select to authenticated
  using (email = auth_email() or is_admin());
create policy "admins superadmin write" on admins for all to authenticated
  using (is_super_admin()) with check (is_super_admin());

-- Submissions: students own rows only; admins everything
create policy "submissions select" on submissions for select to authenticated
  using (student_id = my_student_id() or is_admin());
create policy "submissions student insert" on submissions for insert to authenticated
  with check (student_id = my_student_id());
create policy "submissions admin update" on submissions for update to authenticated
  using (is_admin()) with check (is_admin());
create policy "submissions superadmin delete" on submissions for delete to authenticated
  using (is_super_admin());

-- Authors: owner student can add/delete; admins can only edit text
create policy "authors select" on submission_authors for select to authenticated
  using (is_admin() or exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "authors student insert" on submission_authors for insert to authenticated
  with check (exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "authors student delete" on submission_authors for delete to authenticated
  using (exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "authors admin update" on submission_authors for update to authenticated
  using (is_admin()) with check (is_admin());

-- Status history: append-only via trigger; readable by owner/admin
create policy "status_history select" on status_history for select to authenticated
  using (is_admin() or exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));

-- Remarks: admins write; owner/admin read
create policy "remarks select" on remarks for select to authenticated
  using (is_admin() or exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "remarks admin insert" on remarks for insert to authenticated
  with check (is_admin());

-- Certificates: admins issue; owner/admin read
create policy "certificates select" on certificates for select to authenticated
  using (is_admin() or exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "certificates admin insert" on certificates for insert to authenticated
  with check (is_admin());

-- Problems + defects: owner/admin read; admins manage
create policy "problems select" on problems for select to authenticated
  using (is_admin() or exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "problems admin write" on problems for all to authenticated
  using (is_admin()) with check (is_admin());

create policy "defects select" on formality_defects for select to authenticated
  using (is_admin() or exists (
    select 1 from submissions s where s.id = submission_id and s.student_id = my_student_id()));
create policy "defects admin write" on formality_defects for all to authenticated
  using (is_admin()) with check (is_admin());

create policy "defect comments select" on formality_defect_comments for select to authenticated
  using (is_admin() or exists (
    select 1 from formality_defects d join submissions s on s.id = d.submission_id
    where d.id = formality_defect_id and s.student_id = my_student_id()));
create policy "defect comments admin insert" on formality_defect_comments for insert to authenticated
  with check (is_admin());

-- Notification log: admins read all; students read rows addressed to them
create policy "notifications select" on notifications_log for select to authenticated
  using (is_admin() or recipient = auth_email());

-- Admin action log: super_admin reads; admins may write their own actions
create policy "action log select" on admin_action_log for select to authenticated
  using (is_super_admin());
create policy "action log insert" on admin_action_log for insert to authenticated
  with check (is_admin());

-- Events: any authenticated user reads; admins manage
create policy "events select" on events for select to authenticated using (true);
create policy "events admin write" on events for all to authenticated
  using (is_admin()) with check (is_admin());

-- Registrations: students manage own rows; admins read all + approve/decline
create policy "registrations select" on event_registrations for select to authenticated
  using (student_id = my_student_id() or is_admin());
create policy "registrations student insert" on event_registrations for insert to authenticated
  with check (student_id = my_student_id());
create policy "registrations student cancel" on event_registrations for delete to authenticated
  using (student_id = my_student_id());
create policy "registrations admin update" on event_registrations for update to authenticated
  using (is_admin()) with check (is_admin());

-- ============================================================
-- Grants
-- ============================================================
grant execute on function auth_email() to authenticated;
grant execute on function my_role() to authenticated;
grant execute on function is_admin() to authenticated;
grant execute on function is_super_admin() to authenticated;
grant execute on function my_student_id() to authenticated;
grant execute on function log_admin_action(text, text, jsonb) to authenticated;

-- ============================================================
-- FIRST ADMIN SEED — edit the email, then run this block:
-- ============================================================
-- insert into authorized_emails (email, role)
-- values ('YOUR-EMAIL@gmail.com', 'super_admin');
--
-- insert into admins (email, full_name, role)
-- select email, 'ITSO Administrator', 'super_admin'
-- from authorized_emails where email = 'YOUR-EMAIL@gmail.com';
--
-- Test student (optional):
-- insert into authorized_emails (email, role) values ('you+student@gmail.com', 'student');
-- insert into students (email, full_name, student_id_number, college_id, program_id)
-- select 'you+student@gmail.com', 'Test Student', '22-0145', c.id, p.id
-- from colleges c, programs p
-- where c.name = 'College of Computer Studies' and p.name = 'BS Information Technology (BSIT)';

-- ============================================================
-- TODO later (Phase 5/6 — needs pg_cron + Edge Functions):
--   SER deadline reminders (monthly from month 17 until handled)
--   Formality defect deadline reminders (monthly from final month)
--   Notification emails via Resend edge function
--   Automatic 10-year archiving job
-- ============================================================

-- Table privileges (RLS still filters rows)
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
