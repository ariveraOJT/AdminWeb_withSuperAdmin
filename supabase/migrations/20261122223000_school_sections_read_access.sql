-- The client reads each staff profile together with its assigned sections
-- (users -> staff_section_assignments -> school_sections) while signing in.
-- school_sections was created locked down, which caused
-- "permission denied for table school_sections" at login.
-- Allow signed-in users to READ sections only; all writes stay service-role only.

begin;

grant select on table public.school_sections to authenticated;

drop policy if exists school_sections_select_authenticated on public.school_sections;
create policy school_sections_select_authenticated
  on public.school_sections for select to authenticated
  using (true);

commit;
