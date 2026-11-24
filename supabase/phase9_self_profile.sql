-- ============================================================
-- QCU ITSO — Self-service profile update (run once after phase6_links_events.sql)
-- Lets a signed-in user correct their legal name; students can also fix
-- student ID + program. Unlike complete_my_profile this can be re-run.
-- ============================================================

create or replace function update_my_profile(
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
    if p_student_id_number is null or p_student_id_number !~ '^\d{2}-\d{4}$' then
      raise exception 'Student ID must be in xx-xxxx format';
    end if;
    select college_id into v_college from programs where id = p_program_id;
    if v_college is null then raise exception 'Select a valid program'; end if;
    begin
      update students set
        full_name = v_full, given_name = p_given, middle_name = p_middle,
        family_name = p_family, suffix = p_suffix,
        student_id_number = p_student_id_number,
        college_id = v_college, program_id = p_program_id
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

grant execute on function update_my_profile(text, text, text, text, text, smallint) to authenticated;
revoke execute on function update_my_profile(text, text, text, text, text, smallint) from anon;

notify pgrst, 'reload schema';
