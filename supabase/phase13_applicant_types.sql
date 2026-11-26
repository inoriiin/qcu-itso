-- ============================================================
-- QCU ITSO — Phase 13 applicant types (run after phase12)
-- Non-QCU applicants and QCU faculty/staff can file. The whitelist
-- 'student' role stays the generic "applicant" account; students.applicant_type
-- is 'student' | 'staff' | 'external'. Student ID is now optional.
-- ============================================================

do $$ begin
  create type applicant_type as enum ('student', 'staff', 'external');
exception when duplicate_object then null;
end $$;

alter table students
  add column if not exists applicant_type applicant_type not null default 'student',
  add column if not exists affiliation text;

alter table students alter column student_id_number drop not null;
alter table students drop constraint if exists students_student_id_number_check;
alter table students add constraint students_student_id_number_check
  check (student_id_number is null or student_id_number ~ '^\d{2}-\d{4}$');

alter table submissions
  add column if not exists applicant_type applicant_type not null default 'student',
  add column if not exists affiliation text;
alter table submissions alter column college_id drop not null;
alter table submissions alter column program_id drop not null;
alter table submissions alter column student_submitted_id_number drop not null;

-- Current user's profile (null fields when no profile row yet)
create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('full_name', full_name, 'given_name', given_name, 'middle_name', middle_name,
       'family_name', family_name, 'suffix', suffix, 'profile_completed', profile_completed,
       'student_id_number', student_id_number, 'program_id', program_id, 'college_id', college_id,
       'applicant_type', applicant_type, 'affiliation', affiliation)
     from students where email = auth_email()),
    (select jsonb_build_object('full_name', full_name, 'given_name', given_name, 'middle_name', middle_name,
       'family_name', family_name, 'suffix', suffix, 'profile_completed', profile_completed)
     from admins where email = auth_email()),
    jsonb_build_object('profile_completed', false)
  )
$$;

-- One-time onboarding. Applicant-role users: name + classification fields.
-- Admins: name only.
drop function if exists complete_my_profile(text, text, text, text, text, smallint);
create or replace function complete_my_profile(
  p_given text, p_middle text, p_family text, p_suffix text,
  p_applicant_type text default 'student',
  p_student_id_number text default null,
  p_program_id smallint default null,
  p_college_id smallint default null,
  p_affiliation text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := my_role();
  v_email text := auth_email();
  v_full text;
  v_college smallint;
begin
  if v_role is null then raise exception 'Not authorized'; end if;
  p_given := nullif(trim(p_given), '');
  p_middle := nullif(trim(p_middle), '');
  p_family := nullif(trim(p_family), '');
  p_suffix := nullif(trim(p_suffix), '');
  p_student_id_number := nullif(trim(p_student_id_number), '');
  p_affiliation := nullif(trim(p_affiliation), '');
  if p_given is null or p_family is null then
    raise exception 'Given name and family name are required';
  end if;
  v_full := concat_ws(' ', p_given, p_middle, p_family, p_suffix);

  if v_role = 'student' then
    if exists (select 1 from students where email = v_email and profile_completed) then
      raise exception 'Profile already completed — contact ITSO to change it';
    end if;
    if p_applicant_type not in ('student', 'staff', 'external') then
      raise exception 'Invalid classification';
    end if;
    if p_applicant_type = 'student' then
      select college_id into v_college from programs where id = p_program_id;
      if v_college is null then raise exception 'Select a valid program'; end if;
      if p_student_id_number is not null and p_student_id_number !~ '^\d{2}-\d{4}$' then
        raise exception 'Student ID must be in xx-xxxx format';
      end if;
      p_college_id := v_college;
      p_affiliation := null;
    elsif p_applicant_type = 'staff' then
      if p_affiliation is null then raise exception 'Office / department is required'; end if;
      if p_college_id is not null and not exists (select 1 from colleges where id = p_college_id) then
        raise exception 'Select a valid college';
      end if;
      p_program_id := null;
      p_student_id_number := null;
    else
      if p_affiliation is null then raise exception 'Organization / institution is required'; end if;
      p_college_id := null;
      p_program_id := null;
      p_student_id_number := null;
    end if;
    insert into students (email, full_name, given_name, middle_name, family_name, suffix,
                          applicant_type, affiliation, student_id_number, college_id, program_id, profile_completed)
    values (v_email, v_full, p_given, p_middle, p_family, p_suffix,
            p_applicant_type::applicant_type, p_affiliation, p_student_id_number, p_college_id, p_program_id, true)
    on conflict (email) do update set
      full_name = excluded.full_name, given_name = excluded.given_name,
      middle_name = excluded.middle_name, family_name = excluded.family_name,
      suffix = excluded.suffix, applicant_type = excluded.applicant_type,
      affiliation = excluded.affiliation, student_id_number = excluded.student_id_number,
      college_id = excluded.college_id, program_id = excluded.program_id,
      profile_completed = true;
  else
    if exists (select 1 from admins where email = v_email and profile_completed) then
      raise exception 'Profile already completed';
    end if;
    insert into admins (email, full_name, given_name, middle_name, family_name, suffix, role, profile_completed)
    values (v_email, v_full, p_given, p_middle, p_family, p_suffix, v_role, true)
    on conflict (email) do update set
      full_name = excluded.full_name, given_name = excluded.given_name,
      middle_name = excluded.middle_name, family_name = excluded.family_name,
      suffix = excluded.suffix, profile_completed = true;
  end if;
end $$;

-- Self-service profile update (re-runnable, unlike complete_my_profile).
drop function if exists update_my_profile(text, text, text, text, text, smallint);
create or replace function update_my_profile(
  p_given text, p_middle text, p_family text, p_suffix text,
  p_applicant_type text default 'student',
  p_student_id_number text default null,
  p_program_id smallint default null,
  p_college_id smallint default null,
  p_affiliation text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := my_role();
  v_email text := auth_email();
  v_full text;
  v_college smallint;
begin
  if v_role is null then raise exception 'Not authorized'; end if;
  p_given := nullif(trim(p_given), '');
  p_middle := nullif(trim(p_middle), '');
  p_family := nullif(trim(p_family), '');
  p_suffix := nullif(trim(p_suffix), '');
  p_student_id_number := nullif(trim(p_student_id_number), '');
  p_affiliation := nullif(trim(p_affiliation), '');
  if p_given is null or p_family is null then
    raise exception 'Given name and family name are required';
  end if;
  v_full := concat_ws(' ', p_given, p_middle, p_family, p_suffix);

  if v_role = 'student' then
    if p_applicant_type not in ('student', 'staff', 'external') then
      raise exception 'Invalid classification';
    end if;
    if p_applicant_type = 'student' then
      select college_id into v_college from programs where id = p_program_id;
      if v_college is null then raise exception 'Select a valid program'; end if;
      if p_student_id_number is not null and p_student_id_number !~ '^\d{2}-\d{4}$' then
        raise exception 'Student ID must be in xx-xxxx format';
      end if;
      p_college_id := v_college;
      p_affiliation := null;
    elsif p_applicant_type = 'staff' then
      if p_affiliation is null then raise exception 'Office / department is required'; end if;
      if p_college_id is not null and not exists (select 1 from colleges where id = p_college_id) then
        raise exception 'Select a valid college';
      end if;
      p_program_id := null;
      p_student_id_number := null;
    else
      if p_affiliation is null then raise exception 'Organization / institution is required'; end if;
      p_college_id := null;
      p_program_id := null;
      p_student_id_number := null;
    end if;
    begin
      update students set
        full_name = v_full, given_name = p_given, middle_name = p_middle,
        family_name = p_family, suffix = p_suffix,
        applicant_type = p_applicant_type::applicant_type,
        affiliation = p_affiliation,
        student_id_number = p_student_id_number,
        college_id = p_college_id, program_id = p_program_id
      where email = v_email;
    exception when unique_violation then
      raise exception 'That student ID is already used by another account';
    end;
    if not found then raise exception 'Profile not found'; end if;
  else
    update admins set
      full_name = v_full, given_name = p_given, middle_name = p_middle,
      family_name = p_family, suffix = p_suffix
    where email = v_email;
    if not found then raise exception 'Profile not found'; end if;
  end if;
end $$;

grant execute on function my_profile() to authenticated;
grant execute on function complete_my_profile(text, text, text, text, text, text, smallint, smallint, text) to authenticated;
revoke execute on function complete_my_profile(text, text, text, text, text, text, smallint, smallint, text) from anon;
grant execute on function update_my_profile(text, text, text, text, text, text, smallint, smallint, text) to authenticated;
revoke execute on function update_my_profile(text, text, text, text, text, text, smallint, smallint, text) from anon;

-- Submission payload: LEFT JOINs so staff/external rows (no
-- college/program) still produce emails; adds classification + affiliation.
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
    'classification', case s.applicant_type
      when 'staff' then 'QCU Faculty / Staff'
      when 'external' then 'External (Non-QCU)'
      else 'QCU Student' end,
    'affiliation', s.affiliation,
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
  left join colleges c on c.id = s.college_id
  left join programs pr on pr.id = s.program_id
  where s.id = p_submission
$$;

-- Registration notifications: include the registrant's classification
-- so admin emails can show it (student_id is null for staff/external).
create or replace function notify_registration() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_name text;
  v_sid text;
  v_class text;
  v_event jsonb;
begin
  select st.email, st.full_name, st.student_id_number,
         case st.applicant_type
           when 'staff' then 'QCU Faculty / Staff'
           when 'external' then 'External (Non-QCU)'
           else 'QCU Student' end
    into v_email, v_name, v_sid, v_class
    from students st where st.id = new.student_id;
  select jsonb_build_object('event', e.title, 'activity_type', e.activity_type,
      'activity_other', e.activity_type_other, 'date', e.event_date, 'mode', e.mode_of_delivery,
      'duration_days', e.duration_days, 'duration_hours', e.duration_hours,
      'student', v_name, 'student_id', v_sid, 'classification', v_class)
    into v_event from events e where e.id = new.event_id;
  if tg_op = 'INSERT' then
    perform notify(v_email, 'registration_received', v_event);
    perform notify('admin', 'registration_request', v_event);
  elsif new.status is distinct from old.status then
    perform notify(v_email, 'registration_' || new.status::text, v_event);
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
