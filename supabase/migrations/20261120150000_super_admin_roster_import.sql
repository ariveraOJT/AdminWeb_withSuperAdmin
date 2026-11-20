begin;

do $prerequisites$
begin
  if to_regclass('public.users') is null
    or to_regclass('public.students') is null
    or to_regclass('public.school_sections') is null
    or to_regclass('public.school_settings') is null
    or to_regclass('public.etl_runs') is null
    or to_regclass('public.etl_rejected_records') is null
    or to_regclass('public.etl_pending_staff') is null
    or to_regclass('public.activity_logs') is null then
    raise exception
      'Missing required HayagSYNC schema tables. Install the matching base schema and apply the roster ETL migrations before this Super Admin migration.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'auth_user_id'
      and data_type = 'uuid'
  ) then
    raise exception
      'This migration requires the legacy public.users schema with a UUID auth_user_id column.';
  end if;

  if to_regprocedure('public.append_roster_import(text,jsonb,jsonb,jsonb,uuid)') is null then
    raise exception
      'Missing public.append_roster_import. Apply 20261108001000_current_roster_etl.sql before this Super Admin migration.';
  end if;
end
$prerequisites$;

alter table public.students
  add column if not exists is_active boolean not null default true;

create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $function$
  select exists (
    select 1
    from public.users as u
    where u.auth_user_id = auth.uid()
      and u.is_active
      and u.role = 'super_admin'
  )
$function$;

revoke all on function private.is_super_admin() from public, anon;
grant execute on function private.is_super_admin() to authenticated;

create or replace function public.student_registration_matches(
  p_student_no text,
  p_full_name text,
  p_currently_section text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(exists (
    select 1
    from public.students as s
    where s.is_active
      and s.lrn = btrim(coalesce(p_student_no, ''))
      and lower(btrim(s.name)) = lower(btrim(coalesce(p_full_name, '')))
      and (
        lower(btrim(s.section)) = lower(btrim(coalesce(p_currently_section, '')))
        or lower(btrim(s.grade || ' - ' || s.section))
          = lower(btrim(coalesce(p_currently_section, '')))
      )
  ), false)
$function$;

revoke all on function public.student_registration_matches(text, text, text)
  from public, anon, authenticated;
grant execute on function public.student_registration_matches(text, text, text)
  to anon, authenticated;

drop trigger if exists etl_runs_require_principal_importer on public.etl_runs;

create or replace function private.require_super_admin_roster_import()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_user_id uuid;
begin
  if coalesce(new.details ->> 'uploaded_by', '') !~*
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Roster imports must identify an active Super Admin account.';
  end if;

  v_actor_user_id := (new.details ->> 'uploaded_by')::uuid;
  if not exists (
    select 1
    from public.users as profile
    where profile.auth_user_id = v_actor_user_id
      and profile.is_active
      and profile.role = 'super_admin'
  ) then
    raise exception 'Only an active Super Admin account can import roster data.';
  end if;

  return new;
end
$function$;

revoke all on function private.require_super_admin_roster_import()
  from public, anon, authenticated;

create trigger etl_runs_require_super_admin_importer
  before insert on public.etl_runs
  for each row
  execute function private.require_super_admin_roster_import();

do $migration$
declare
  v_function_definition text;
begin
  select pg_get_functiondef(
    'public.append_roster_import(text,jsonb,jsonb,jsonb,uuid)'::regprocedure
  )
  into v_function_definition;

  v_function_definition := replace(
    v_function_definition,
    'where u.id = p_actor_user_id',
    'where u.auth_user_id = p_actor_user_id'
  );
  v_function_definition := replace(
    v_function_definition,
    'u.role = ''principal''',
    'u.role = ''super_admin'''
  );
  v_function_definition := replace(
    v_function_definition,
    'Only an active Principal account can import current roster data.',
    'Only an active Super Admin account can import current roster data.'
  );

  if position('u.auth_user_id = p_actor_user_id' in v_function_definition) = 0
    or position('u.role = ''super_admin''' in v_function_definition) = 0 then
    raise exception 'Could not update the current roster import function for Super Admin access.';
  end if;

  execute v_function_definition;
end
$migration$;

drop policy if exists etl_runs_select_roster_admin on public.etl_runs;
drop policy if exists etl_runs_select_super_admin on public.etl_runs;
create policy etl_runs_select_super_admin
  on public.etl_runs for select to authenticated
  using (private.is_super_admin());

drop policy if exists etl_rejected_records_select_roster_admin on public.etl_rejected_records;
drop policy if exists etl_rejected_records_select_super_admin on public.etl_rejected_records;
create policy etl_rejected_records_select_super_admin
  on public.etl_rejected_records for select to authenticated
  using (private.is_super_admin());

drop policy if exists etl_pending_staff_select_roster_admin on public.etl_pending_staff;
drop policy if exists etl_pending_staff_select_super_admin on public.etl_pending_staff;
create policy etl_pending_staff_select_super_admin
  on public.etl_pending_staff for select to authenticated
  using (private.is_super_admin());

drop policy if exists activity_logs_select_super_admin on public.activity_logs;
create policy activity_logs_select_super_admin
  on public.activity_logs for select to authenticated
  using (private.is_super_admin());

create or replace function private.log_super_admin_roster_import()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid;
  v_actor_email text;
begin
  if old.status = 'started'
    and new.status in ('completed', 'completed_with_errors', 'failed') then
    v_actor_id := nullif(new.details ->> 'uploaded_by', '')::uuid;

    select u.email
    into v_actor_email
    from public.users as u
    where u.auth_user_id = v_actor_id
      and u.role = 'super_admin';

    insert into public.activity_logs (
      user_email,
      user_role,
      action,
      entity_name,
      record_id,
      new_values
    )
    values (
      v_actor_email,
      'super_admin',
      case when new.status = 'completed' then 'STUDENT_ROSTER_IMPORTED' else 'STUDENT_ROSTER_IMPORT_REJECTED' end,
      'student_roster',
      new.batch_id::text,
      jsonb_build_object(
        'source_file', new.source_file,
        'status', new.status,
        'students_added', new.students_inserted,
        'students_updated', new.students_updated,
        'students_deactivated', new.students_deactivated,
        'rejected_count', new.rejected_count
      )
    );
  end if;
  return new;
end
$function$;

revoke all on function private.log_super_admin_roster_import()
  from public, anon, authenticated;

drop trigger if exists etl_runs_audit_super_admin_import on public.etl_runs;
create trigger etl_runs_audit_super_admin_import
  after update of status on public.etl_runs
  for each row
  execute function private.log_super_admin_roster_import();

commit;
