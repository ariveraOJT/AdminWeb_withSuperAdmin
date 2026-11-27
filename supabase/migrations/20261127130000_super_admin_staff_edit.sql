begin;

create or replace function public.update_staff_profile(
  p_profile_id bigint,
  p_role text,
  p_assigned_scope text,
  p_section_ids uuid[],
  p_actor_email text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_profile record;
  v_section_ids uuid[] := coalesce(p_section_ids, array[]::uuid[]);
  v_section_count integer;
  v_new_assigned_section text;
  v_old_sections jsonb;
  v_new_sections jsonb;
begin
  if p_actor_email is null or btrim(p_actor_email) = '' then
    raise exception 'A Super Admin identity is required to record this change.';
  end if;

  if p_role is null or p_role not in (
    'adviser',
    'principal',
    'ministrong_tagasubaybay',
    'osd',
    'board_of_discipline',
    'school_president'
  ) then
    raise exception 'Choose a supported staff position.';
  end if;

  if p_assigned_scope is not null and length(btrim(p_assigned_scope)) > 150 then
    raise exception 'Assigned section or scope must be 150 characters or fewer.';
  end if;

  if cardinality(v_section_ids) <> (
    select count(distinct section_id)::integer
    from unnest(v_section_ids) as selected(section_id)
  ) then
    raise exception 'A section was selected more than once.';
  end if;

  if p_role in ('adviser', 'principal', 'ministrong_tagasubaybay')
     and cardinality(v_section_ids) = 0 then
    raise exception 'Choose at least one section for this position.';
  end if;

  if p_role not in ('adviser', 'principal', 'ministrong_tagasubaybay')
     and cardinality(v_section_ids) > 0 then
    raise exception 'This position does not use section assignments.';
  end if;

  select id, role, assigned_section
  into v_profile
  from public.users
  where id = p_profile_id
    and role = any (array[
      'adviser',
      'principal',
      'ministrong_tagasubaybay',
      'osd',
      'board_of_discipline',
      'school_president'
    ])
  for update;

  if not found then
    raise exception 'The selected staff account was not found.' using errcode = 'P0002';
  end if;

  select
    count(*)::integer,
    string_agg(school_section.grade || ' - ' || school_section.section_name, ', ' order by school_section.grade, school_section.section_name),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', school_section.id,
          'grade', school_section.grade,
          'section_name', school_section.section_name
        )
        order by school_section.grade, school_section.section_name
      ),
      '[]'::jsonb
    )
  into v_section_count, v_new_assigned_section, v_new_sections
  from public.school_sections as school_section
  where school_section.id = any (v_section_ids);

  if v_section_count <> cardinality(v_section_ids) then
    raise exception 'One or more selected sections no longer exist.';
  end if;

  if p_role in ('adviser', 'principal', 'ministrong_tagasubaybay') then
    v_new_assigned_section := nullif(v_new_assigned_section, '');
  else
    v_new_assigned_section := nullif(btrim(coalesce(p_assigned_scope, '')), '');
    v_new_sections := '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', assignment.section_id,
        'grade', school_section.grade,
        'section_name', school_section.section_name
      )
      order by school_section.grade, school_section.section_name
    ),
    '[]'::jsonb
  )
  into v_old_sections
  from public.staff_section_assignments as assignment
  left join public.school_sections as school_section on school_section.id = assignment.section_id
  where assignment.staff_id = p_profile_id;

  update public.users
  set role = p_role,
      assigned_section = v_new_assigned_section
  where id = p_profile_id;

  delete from public.staff_section_assignments
  where staff_id = p_profile_id;

  if cardinality(v_section_ids) > 0 then
    insert into public.staff_section_assignments (staff_id, section_id)
    select p_profile_id, selected.section_id
    from unnest(v_section_ids) as selected(section_id);
  end if;

  insert into public.activity_logs (
    user_email,
    user_role,
    action,
    entity_name,
    record_id,
    old_values,
    new_values
  ) values (
    p_actor_email,
    'super_admin',
    'STAFF_UPDATED',
    'staff',
    p_profile_id::text,
    jsonb_build_object(
      'role', v_profile.role,
      'assigned_section', v_profile.assigned_section,
      'sections', v_old_sections
    ),
    jsonb_build_object(
      'role', p_role,
      'assigned_section', v_new_assigned_section,
      'sections', v_new_sections
    )
  );

  return jsonb_build_object(
    'old_values', jsonb_build_object(
      'role', v_profile.role,
      'assigned_section', v_profile.assigned_section,
      'sections', v_old_sections
    ),
    'new_values', jsonb_build_object(
      'role', p_role,
      'assigned_section', v_new_assigned_section,
      'sections', v_new_sections
    )
  );
end
$function$;

revoke all on function public.update_staff_profile(bigint, text, text, uuid[], text)
  from public, anon, authenticated;
grant execute on function public.update_staff_profile(bigint, text, text, uuid[], text)
  to service_role;

notify pgrst, 'reload schema';

commit;
