-- ============================================================
-- QCU ITSO — Schema fixups (run once after schema.sql)
-- ============================================================

-- Events need a venue (onsite location or online meeting link) + start time
alter table events add column if not exists venue text;
alter table events add column if not exists start_time time;

-- Table privileges: RLS only filters rows the role can already reach.
-- Some Supabase projects don't auto-grant on SQL-created tables.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- Phase 4 permission split: regular admins can manage STUDENT whitelist
-- entries; only super_admin can touch admin/super_admin rows.
create policy "whitelist admin write students" on authorized_emails
  for all to authenticated
  using (is_admin() and role = 'student')
  with check (is_admin() and role = 'student');
