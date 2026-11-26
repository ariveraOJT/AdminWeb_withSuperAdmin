-- Point staff_section_assignments at public.school_sections (uuid ids).
--
-- The manage-staff Edge Function embeds school_sections from
-- staff_section_assignments and inserts { staff_id, section_id } where
-- section_id is a school_sections uuid. The legacy table still had a bigint
-- section_id referencing public.sections, so the relationship did not exist.
--
-- Safe only while staff_section_assignments is empty (it had 0 rows when this
-- migration was written); it aborts instead of touching existing assignments.

begin;

do $guard$
begin
  if exists (select 1 from public.staff_section_assignments) then
    raise exception
      'staff_section_assignments already contains rows. Migrate them manually before switching section_id to school_sections.';
  end if;
end
$guard$;

alter table public.staff_section_assignments
  drop constraint if exists staff_section_assignments_section_id_fkey;

alter table public.staff_section_assignments
  drop column section_id;

alter table public.staff_section_assignments
  add column section_id uuid not null
    references public.school_sections (id) on delete cascade;

create unique index if not exists staff_section_assignments_staff_section_uidx
  on public.staff_section_assignments (staff_id, section_id);

create index if not exists staff_section_assignments_section_idx
  on public.staff_section_assignments (section_id);

-- Make PostgREST pick up the new relationship immediately.
notify pgrst, 'reload schema';

commit;
