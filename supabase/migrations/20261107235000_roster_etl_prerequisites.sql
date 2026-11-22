-- Bridge migration: prerequisites for 20261108001000_current_roster_etl.sql and
-- 20261120150000_super_admin_roster_import.sql on the legacy schema
-- (public.users.id is bigint, auth link is public.users.auth_user_id uuid).
--
-- Additive only: nothing existing is dropped or renamed. The legacy
-- public.sections table and public.staff_section_assignments are left untouched.

begin;

create schema if not exists private;

-- 1. school_sections (used by the roster import to register grade/section).
--    The unique index on (grade, section_name, academic_year) is created by
--    20261108001000_current_roster_etl.sql.
create table if not exists public.school_sections (
  id uuid primary key default gen_random_uuid(),
  grade text not null,
  section_name text not null,
  academic_year text not null,
  created_at timestamptz not null default now()
);

alter table public.school_sections enable row level security;
revoke all on table public.school_sections from public, anon, authenticated;

-- 2. school_settings (single row; holds the current academic year).
create table if not exists public.school_settings (
  singleton_id smallint primary key default 1 check (singleton_id = 1),
  school_name text not null,
  division text not null default '',
  academic_year text not null,
  policy_framework text not null default '',
  auto_escalate_days integer not null default 0 check (auto_escalate_days >= 0),
  require_guardian_countersign boolean not null default false,
  updated_at timestamptz not null default now()
);

-- PLACEHOLDER VALUES: edit them after the push, for example:
--   update public.school_settings
--   set school_name = 'Your School Name', academic_year = '2026-2027'
--   where singleton_id = 1;
insert into public.school_settings (singleton_id, school_name, academic_year)
values (1, 'HayagSYNC School', '2026-2027')
on conflict (singleton_id) do nothing;

alter table public.school_settings enable row level security;
revoke all on table public.school_settings from public, anon, authenticated;

-- 3. The roster import function stamps students.updated_at.
alter table public.students
  add column if not exists updated_at timestamptz not null default now();

-- 4. Policy helper used by 20261108001000 (created only if it does not exist).
do $prerequisites$
begin
  if to_regprocedure('private.has_roster_admin_role()') is null then
    execute $fn$
      create function private.has_roster_admin_role()
      returns boolean
      language sql
      stable
      security definer
      set search_path = pg_catalog, public, auth
      as $body$
        select exists (
          select 1
          from public.users as u
          where u.auth_user_id = auth.uid()
            and u.is_active
            and u.role in ('osd', 'principal', 'school_president')
        )
      $body$
    $fn$;

    revoke all on function private.has_roster_admin_role() from public, anon;
    grant execute on function private.has_roster_admin_role() to authenticated;
  end if;
end
$prerequisites$;

commit;
