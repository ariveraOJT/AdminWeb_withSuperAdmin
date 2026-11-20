begin;

do $migration$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'auth_user_id'
      and data_type = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'id'
      and data_type = 'bigint'
  ) then
    raise exception
      'This migration requires the legacy public.users schema with a UUID auth_user_id column.';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = any (array['is_active', 'must_change_password'])
  ) <> 2 then
    raise exception
      'Apply the staff-auth onboarding migration and legacy password-setup migration before Super Admin management.';
  end if;
end
$migration$;

alter table public.users
  drop constraint if exists users_role_check;

alter table public.users
  add constraint users_role_check
  check (role = any (array[
    'parent',
    'adviser',
    'principal',
    'ministrong_tagasubaybay',
    'osd',
    'board_of_discipline',
    'school_president',
    'super_admin'
  ]));

create unique index if not exists users_one_active_super_admin_idx
  on public.users (role)
  where role = 'super_admin' and is_active;

create or replace function private.current_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $function$
  select u.role
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.is_active
  limit 1
$function$;

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public, auth
as $function$
  select u.role
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.is_active
  limit 1
$function$;

create or replace function public.current_profile_id()
returns bigint
language sql
stable
security definer
set search_path = public, auth
as $function$
  select u.id
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.is_active
    and u.role <> 'super_admin'
  limit 1
$function$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $function$
  select coalesce((
    select u.role = any (array[
      'adviser',
      'principal',
      'ministrong_tagasubaybay',
      'osd',
      'board_of_discipline',
      'school_president'
    ])
    from public.users as u
    where u.auth_user_id = auth.uid()
      and u.is_active
    limit 1
  ), false)
$function$;

create or replace function public.can_access_report(p_report_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $function$
  select coalesce(
    case
      when public.current_app_role() = any (array[
        'adviser',
        'principal',
        'ministrong_tagasubaybay',
        'osd',
        'board_of_discipline',
        'school_president'
      ]) then public.is_staff()
      when public.current_app_role() = 'parent' then exists (
        select 1
        from public.reports as r
        where r.id = p_report_id
          and (
            r.parent_id = public.current_profile_id()
            or public.parent_has_student_access(r.student_id)
          )
      )
      else false
    end,
    false
  )
$function$;

create or replace function public.complete_my_password_setup()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $function$
begin
  if auth.uid() is null then
    raise exception 'A signed-in account is required.';
  end if;

  update public.users
  set must_change_password = false
  where auth_user_id = auth.uid()
    and is_active
    and role in (
      'adviser',
      'board_of_discipline',
      'ministrong_tagasubaybay',
      'osd',
      'principal',
      'school_president',
      'super_admin'
    );

  if not found then
    raise exception 'An active staff profile is required.';
  end if;
end
$function$;

revoke all on function public.complete_my_password_setup()
  from public, anon, authenticated;
grant execute on function public.complete_my_password_setup()
  to authenticated;

revoke insert, update, delete on public.users from anon, authenticated;
grant select on public.users to authenticated;

commit;
