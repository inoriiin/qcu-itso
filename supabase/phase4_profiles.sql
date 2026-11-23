-- ============================================================
-- QCU ITSO — Profiles / legal names (run once after phase3_notifications.sql)
-- First sign-in asks every user for their legal government name.
-- Students also provide student ID + program (creates their profile row
-- when an admin only whitelisted their email).
-- ============================================================

alter table students
  add column if not exists given_name text,
  add column if not exists middle_name text,
  add column if not exists family_name text,
  add column if not exists suffix text,
  add column if not exists profile_completed boolean not null default false;

alter table admins
  add column if not exists given_name text,
  add column if not exists middle_name text,
  add column if not exists family_name text,
  add column if not exists suffix text,
  add column if not exists profile_completed boolean not null default false;

-- Current user's profile (null fields when no profile row yet)
create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('full_name', full_name, 'given_name', given_name, 'middle_name', middle_name,
       'family_name', family_name, 'suffix', suffix, 'profile_completed', profile_completed,
       'student_id_number', student_id_number, 'program_id', program_id)
     from students where email = auth_email()),
    (select jsonb_build_object('full_name', full_name, 'given_name', given_name, 'middle_name', middle_name,
       'family_name', family_name, 'suffix', suffix, 'profile_completed', profile_completed)
     from admins where email = auth_email()),
    jsonb_build_object('profile_completed', false)
  )
$$;

-- One-time onboarding. Students: name + student ID + program. Admins: name only.
create or replace function complete_my_profile(
  p_given text, p_middle text, p_family text, p_suffix text,
  p_student_id_number text default null, p_program_id smallint default null
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
  if p_given is null or p_family is null then
    raise exception 'Given name and family name are required';
  end if;
  v_full := concat_ws(' ', p_given, p_middle, p_family, p_suffix);

  if v_role = 'student' then
    if exists (select 1 from students where email = v_email and profile_completed) then
      raise exception 'Profile already completed — contact ITSO to change it';
    end if;
    if p_student_id_number is null or p_student_id_number !~ '^\d{2}-\d{4}$' then
      raise exception 'Student ID must be in xx-xxxx format';
    end if;
    select college_id into v_college from programs where id = p_program_id;
    if v_college is null then raise exception 'Select a valid program'; end if;
    insert into students (email, full_name, given_name, middle_name, family_name, suffix,
                          student_id_number, college_id, program_id, profile_completed)
    values (v_email, v_full, p_given, p_middle, p_family, p_suffix,
            p_student_id_number, v_college, p_program_id, true)
    on conflict (email) do update set
      full_name = excluded.full_name, given_name = excluded.given_name,
      middle_name = excluded.middle_name, family_name = excluded.family_name,
      suffix = excluded.suffix, student_id_number = excluded.student_id_number,
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

grant execute on function my_profile() to authenticated;
grant execute on function complete_my_profile(text, text, text, text, text, smallint) to authenticated;
revoke execute on function complete_my_profile(text, text, text, text, text, smallint) from anon;
