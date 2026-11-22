import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const MAX_BODY_BYTES = 16 * 1024;
const STAFF_ROLES = [
  'adviser',
  'principal',
  'ministrong_tagasubaybay',
  'osd',
  'board_of_discipline',
  'school_president',
];
const SECTION_ROLES = new Set(['adviser', 'principal', 'ministrong_tagasubaybay']);

type JsonRecord = Record<string, unknown>;

const jsonResponse = (body: JsonRecord, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readText = (value: unknown, label: string, maxLength: number) => {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new Error(`${label} is invalid.`);
  return result;
};

const readSectionIds = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error('Choose the assigned section(s).');
  const sectionIds = value.map((sectionId) => {
    const parsed = String(sectionId).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed)) {
      throw new Error('A selected section is invalid.');
    }
    return parsed;
  });
  if (new Set(sectionIds).size !== sectionIds.length) {
    throw new Error('A section was selected more than once.');
  }
  return sectionIds;
};

const generateTemporaryPassword = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const randomPart = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `Aa1!${randomPart}`;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  const authorization = request.headers.get('Authorization') || '';
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) return jsonResponse({ error: 'A valid sign-in session is required.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('Missing Supabase environment configuration for manage-staff.');
    return jsonResponse({ error: 'The staff account service is not configured.' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await callerClient.auth.getUser(tokenMatch[1]);
  if (authError || !authData.user) {
    return jsonResponse({ error: 'The sign-in session is invalid or expired.' }, 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: actor, error: actorError } = await adminClient
    .from('users')
    .select('role, is_active, email')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();

  if (actorError) {
    console.error('Could not verify staff manager permissions:', actorError);
    return jsonResponse({ error: 'Could not verify account permissions.' }, 500);
  }
  if (!actor?.is_active || actor.role !== 'super_admin') {
    return jsonResponse({ error: 'Only an active Super Admin can manage staff accounts.' }, 403);
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'The request is too large.' }, 413);
  }

  let payload: JsonRecord;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'The request is too large.' }, 413);
    }
    const parsed: unknown = JSON.parse(rawBody);
    if (!isRecord(parsed)) throw new Error('The request body must be an object.');
    payload = parsed;
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid request body.' }, 400);
  }

  if (payload.action === 'list') {
    const [staffResult, sectionsResult] = await Promise.all([
      adminClient
        .from('users')
        .select('id, name, email, role, assigned_section, is_active, must_change_password, staff_section_assignments(section_id, school_sections(id, grade, section_name, academic_year))')
        .in('role', STAFF_ROLES)
        .order('name'),
      adminClient
        .from('school_sections')
        .select('id, grade, section_name, academic_year')
        .order('grade')
        .order('section_name')
    ]);

    if (staffResult.error || sectionsResult.error) {
      const error = staffResult.error || sectionsResult.error;
      console.error('Could not load the staff directory:', error);
      return jsonResponse({ error: `Could not load the staff directory: ${error.message}` }, 500);
    }

    return jsonResponse({
      staff: staffResult.data || [],
      sections: sectionsResult.data || [],
    });
  }

  if (payload.action === 'create') {
    let name: string;
    let email: string;
    let role: string;
    let sectionIds: string[];
    try {
      name = readText(payload.name, 'Staff name', 200);
      email = readText(payload.email, 'Staff email', 320).toLowerCase();
      role = readText(payload.role, 'Staff position', 50);
      sectionIds = readSectionIds(payload.sectionIds);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('Enter a valid staff email address.');
      }
      if (!STAFF_ROLES.includes(role)) {
        throw new Error('Choose a supported staff position.');
      }
      if (SECTION_ROLES.has(role) && sectionIds.length === 0) {
        throw new Error('Choose at least one section for this position.');
      }
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid staff details.' }, 400);
    }

    const { data: existingProfile, error: duplicateError } = await adminClient
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (duplicateError) {
      console.error('Could not check for an existing staff profile:', duplicateError);
      return jsonResponse({ error: 'Could not check whether this staff account already exists.' }, 500);
    }
    if (existingProfile) {
      return jsonResponse({ error: 'A profile already exists for this email. Review the existing staff list.' }, 409);
    }

    let sections: Array<{
      id: string;
      grade: string;
      section_name: string;
      academic_year: string;
    }> = [];
    if (sectionIds.length) {
      const { data, error } = await adminClient
        .from('school_sections')
        .select('id, grade, section_name, academic_year')
        .in('id', sectionIds);
      if (error) {
        console.error('Could not verify selected staff sections:', error);
        return jsonResponse({ error: 'Could not verify the selected sections.' }, 500);
      }
      if ((data || []).length !== sectionIds.length) {
        return jsonResponse({ error: 'One or more selected sections no longer exist.' }, 400);
      }
      sections = data || [];
    }

    const assignedSection = sections
      .map((section) => `${section.grade} - ${section.section_name}`)
      .join(', ');
    const temporaryPassword = generateTemporaryPassword();
    const { data: profile, error: profileError } = await adminClient
      .from('users')
      .insert({
        auth_user_id: null,
        email,
        name,
        role,
        assigned_section: assignedSection || null,
        is_active: true,
        must_change_password: true,
      })
      .select('id')
      .single();
    if (profileError || !profile) {
      console.error('Could not create the pending staff profile:', profileError);
      return jsonResponse({
        error: `Could not create the staff profile: ${profileError?.message || 'No profile was returned.'}`,
      }, 500);
    }

    const { data: authResult, error: createAuthError } = await adminClient.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { name },
    });
    if (createAuthError || !authResult.user) {
      const { error: profileRollbackError } = await adminClient
        .from('users')
        .delete()
        .eq('id', profile.id)
        .is('auth_user_id', null);
      const message = createAuthError?.message || 'Supabase returned no Auth user.';
      console.error('Could not create the staff login:', createAuthError, profileRollbackError);
      return jsonResponse({
        error: `Could not create the login account: ${message}${profileRollbackError ? ` Profile rollback also failed: ${profileRollbackError.message}` : ''}`,
      }, 409);
    }

    const { data: linkedProfile, error: linkError } = await adminClient
      .from('users')
      .update({ auth_user_id: authResult.user.id })
      .eq('id', profile.id)
      .is('auth_user_id', null)
      .select('id')
      .single();
    if (linkError || !linkedProfile) {
      const { error: profileRollbackError } = await adminClient.from('users').delete().eq('id', profile.id);
      const { error: authRollbackError } = await adminClient.auth.admin.deleteUser(authResult.user.id);
      console.error('Could not link the staff profile to its Auth account:', linkError, profileRollbackError, authRollbackError);
      return jsonResponse({
        error: `Could not link the staff profile to its login: ${linkError?.message || 'No linked profile was returned.'}${profileRollbackError ? ` Profile rollback also failed: ${profileRollbackError.message}` : ''}${authRollbackError ? ` Auth rollback also failed: ${authRollbackError.message}` : ''}`,
      }, 500);
    }

    if (sectionIds.length) {
      const { error: assignmentError } = await adminClient
        .from('staff_section_assignments')
        .insert(sectionIds.map((sectionId) => ({
          staff_id: linkedProfile.id,
          section_id: sectionId,
        })));
      if (assignmentError) {
        const { error: profileRollbackError } = await adminClient.from('users').delete().eq('id', linkedProfile.id);
        const { error: authRollbackError } = await adminClient.auth.admin.deleteUser(authResult.user.id);
        console.error('Could not save staff section assignments:', assignmentError, profileRollbackError, authRollbackError);
        return jsonResponse({
          error: `Could not save section assignments: ${assignmentError.message}${profileRollbackError ? ` Profile rollback also failed: ${profileRollbackError.message}` : ''}${authRollbackError ? ` Auth rollback also failed: ${authRollbackError.message}` : ''}`,
        }, 500);
      }
    }

    const { error: auditError } = await adminClient.from('activity_logs').insert({
      user_email: authData.user.email || actor.email,
      user_role: 'super_admin',
      action: 'STAFF_CREATED',
      entity_name: 'staff',
      record_id: String(linkedProfile.id),
      new_values: { name, email, role, assigned_section: assignedSection || null },
    });
    if (auditError) {
      console.error('Staff account was created but its activity could not be recorded:', auditError);
    }

    return jsonResponse({
      staff: {
        id: linkedProfile.id,
        name,
        email,
        role,
        assigned_section: assignedSection,
        is_active: true,
        must_change_password: true,
      },
      temporaryPassword,
      auditWarning: auditError
        ? 'Account created, but the activity could not be recorded. Notify the system administrator.'
        : undefined,
    }, 201);
  }

  if (payload.action === 'deactivate') {
    const profileId = Number(payload.profileId);
    if (!Number.isSafeInteger(profileId) || profileId < 1) {
      return jsonResponse({ error: 'Choose a valid staff account.' }, 400);
    }

    const { data: target, error: targetError } = await adminClient
      .from('users')
      .select('id, auth_user_id, role, is_active')
      .eq('id', profileId)
      .maybeSingle();
    if (targetError) {
      console.error('Could not verify the staff account to deactivate:', targetError);
      return jsonResponse({ error: 'Could not verify the selected staff account.' }, 500);
    }
    if (!target || !STAFF_ROLES.includes(target.role)) {
      return jsonResponse({ error: 'The selected staff account was not found.' }, 404);
    }
    if (target.auth_user_id === authData.user.id) {
      return jsonResponse({ error: 'You cannot deactivate your own account.' }, 400);
    }
    if (!target.is_active) {
      const { error: auditError } = await adminClient.from('activity_logs').insert({
        user_email: authData.user.email || actor.email,
        user_role: 'super_admin',
        action: 'STAFF_DEACTIVATED',
        entity_name: 'staff',
        record_id: String(profileId),
        new_values: { is_active: false },
      });
      if (auditError) {
        console.error('Staff account was deactivated but its activity could not be recorded:', auditError);
      }

      return jsonResponse({
        inactive: true,
        auditWarning: auditError
          ? 'Staff account deactivated, but the activity could not be recorded. Notify the system administrator.'
          : undefined,
      });
    }

    const { error: profileError } = await adminClient
      .from('users')
      .update({ is_active: false })
      .eq('id', profileId)
      .eq('is_active', true);
    if (profileError) {
      console.error('Could not deactivate the staff profile:', profileError);
      return jsonResponse({ error: `Could not deactivate the staff profile: ${profileError.message}` }, 500);
    }

    if (target.auth_user_id) {
      const { error: banError } = await adminClient.auth.admin.updateUserById(target.auth_user_id, {
        ban_duration: '876000h',
      });
      if (banError) {
        const { error: rollbackError } = await adminClient
          .from('users')
          .update({ is_active: true })
          .eq('id', profileId)
          .eq('is_active', false);
        console.error('Could not block the inactive staff login:', banError, rollbackError);
        return jsonResponse({
          error: `The profile could not be fully deactivated: ${banError.message}${rollbackError ? ` Profile rollback also failed: ${rollbackError.message}` : ''}`,
        }, 500);
      }
    }

    return jsonResponse({ inactive: true });
  }

  return jsonResponse({ error: 'Unsupported staff account action.' }, 400);
});
