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
  ) then
    raise exception
      'This migration is only for the legacy public.users schema with a UUID auth_user_id column.';
  end if;
end
$migration$;

create or replace function public.complete_my_password_setup()
returns void
language plpgsql
security definer
set search_path = pg_catalog
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

commit;
