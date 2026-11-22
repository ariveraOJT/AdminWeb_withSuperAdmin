import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 5000;

type UploadedStudentRow = {
  student_no: string;
  currently_section: string;
  full_name: string;
  row_number: number | null;
};

type StudentImportRow = {
  lrn: string;
  name: string;
  grade: string;
  section: string;
  academic_year: string;
  row_number: number | null;
};

type RejectedImportRow = {
  sheet: string;
  row_number: number | null;
  identifier: string;
  reason: string;
};

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const readText = (value: unknown, field: string, maxLength: number, required = false) => {
  if (value == null) {
    if (required) throw new Error(`${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} is required.`);
  if (result.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
  return result;
};

const readRowNumber = (row: Record<string, unknown>) => {
  const value = row.row_number ?? row.rowNumber;
  if (value == null || value === '') return null;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error('Row numbers must be positive integers.');
  }
  return Number(value);
};

const readRows = (value: unknown, label: string) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${label} contains an invalid row.`);
    }
    return row as Record<string, unknown>;
  });
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
    console.error('Missing Supabase environment configuration for append-roster.');
    return jsonResponse({ error: 'The roster import service is not configured.' }, 500);
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
  const { data: profile, error: profileError } = await adminClient
    .from('users')
    .select('role, is_active')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (profileError) {
    console.error('Could not verify the roster importer profile:', profileError);
    return jsonResponse({ error: 'Could not verify your account permissions.' }, 500);
  }
  if (!profile?.is_active || profile.role !== 'super_admin') {
    return jsonResponse({ error: 'Only an active Super Admin can import roster data.' }, 403);
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'The import request exceeds the 4 MB limit.' }, 413);
  }

  let payload: Record<string, unknown>;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'The import request exceeds the 4 MB limit.' }, 413);
    }
    payload = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('The request body must be an object.');
    }
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid JSON request.' }, 400);
  }

  if (payload.action === 'list') {
    const { data: students, error: studentsError } = await adminClient
      .from('students')
      .select('id, lrn, name, grade, section, academic_year')
      .eq('is_active', true)
      .order('name')
      .limit(MAX_ROWS);
    if (studentsError) {
      console.error('Could not load active students for Super Admin:', studentsError);
      return jsonResponse({ error: 'Could not load the active student roster.' }, 500);
    }

    const { error: auditError } = await adminClient.from('activity_logs').insert({
      user_email: authData.user.email || null,
      user_role: 'super_admin',
      action: 'STUDENT_ROSTER_VIEWED',
      entity_name: 'student_roster',
      new_values: { active_students: students?.length || 0 },
    });
    if (auditError) {
      console.error('Could not record the active roster view:', auditError);
      return jsonResponse({ error: 'Could not record this roster access in the activity history.' }, 500);
    }
    return jsonResponse({ students: students || [] });
  }

  const { error: requestAuditError } = await adminClient.from('activity_logs').insert({
    user_email: authData.user.email || null,
    user_role: 'super_admin',
    action: 'STUDENT_ROSTER_IMPORT_REQUESTED',
    entity_name: 'student_roster',
    new_values: { status: 'requested' },
  });
  if (requestAuditError) {
    console.error('Could not record the student roster import request:', requestAuditError);
    return jsonResponse({ error: 'Could not record this roster import in the activity history.' }, 500);
  }

  let uploadedStudents: UploadedStudentRow[];
  let rejected: RejectedImportRow[];
  let sourceFile: string;
  try {
    uploadedStudents = readRows(payload.students, 'Students').map((row) => ({
      student_no: readText(row.student_no, 'Student No.', 12, true).replace(/\s+/g, ''),
      currently_section: readText(row.currently_section, 'Currently Section', 100, true),
      full_name: readText(row.full_name, 'Full Name', 200, true),
      row_number: readRowNumber(row),
    }));
    if (uploadedStudents.length === 0) {
      throw new Error('The Students sheet must contain at least one current student.');
    }
    if (uploadedStudents.some((student) => !/^\d{11,12}$/.test(student.student_no))) {
      throw new Error('Every Student No. must contain 11 or 12 digits.');
    }
    if (new Set(uploadedStudents.map((student) => student.student_no)).size !== uploadedStudents.length) {
      throw new Error('The Students sheet contains duplicate Student No. values.');
    }
    rejected = readRows(payload.rejected ?? [], 'Rejected rows').map((row) => {
      if (readText(row.sheet, 'Rejected sheet', 30, true) !== 'Students') {
        throw new Error('Rejected row has an unsupported sheet name.');
      }
      return {
        sheet: 'Students',
        row_number: readRowNumber(row),
        identifier: readText(row.identifier, 'Rejected-row identifier', 255),
        reason: readText(row.reason, 'Rejection reason', 1000, true),
      };
    });
    sourceFile = readText(payload.sourceFile, 'Source file name', 255, true);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid import data.' }, 400);
  }

  const rowCount = uploadedStudents.length + rejected.length;
  if (rowCount > MAX_ROWS) {
    return jsonResponse({ error: `The workbook must contain no more than ${MAX_ROWS} student rows.` }, 400);
  }

  const { data: settings, error: settingsError } = await adminClient
    .from('school_settings')
    .select('academic_year')
    .limit(1)
    .maybeSingle();
  if (settingsError) {
    console.error('Could not read the current academic year for roster import:', settingsError);
    return jsonResponse({ error: 'Could not verify the current academic year.' }, 500);
  }
  const academicYear = typeof settings?.academic_year === 'string' ? settings.academic_year.trim() : '';
  if (!academicYear) {
    return jsonResponse({ error: 'Set the current academic year in school settings before importing students.' }, 409);
  }

  const { data: sections, error: sectionsError } = await adminClient
    .from('school_sections')
    .select('grade, section_name, academic_year')
    .eq('academic_year', academicYear);
  if (sectionsError) {
    console.error('Could not load current sections for roster import:', sectionsError);
    return jsonResponse({ error: 'Could not verify the uploaded student sections.' }, 500);
  }

  const normalizeSection = (value: string) => value.trim().toLocaleLowerCase();
  const students: StudentImportRow[] = [];
  for (const student of uploadedStudents) {
    const sectionValue = normalizeSection(student.currently_section);
    const matches = (sections || []).filter((section) => (
      normalizeSection(section.section_name) === sectionValue
      || normalizeSection(`${section.grade} - ${section.section_name}`) === sectionValue
    ));

    let matchedSection = matches.length === 1 ? matches[0] : null;
    if (!matchedSection && matches.length === 0) {
      const fullSection = student.currently_section.match(/^(Grade\s+\d+)\s*-\s*(.+)$/i);
      if (fullSection) {
        matchedSection = {
          grade: fullSection[1].trim(),
          section_name: fullSection[2].trim(),
          academic_year: academicYear,
        };
      }
    }
    if (!matchedSection) {
      return jsonResponse({
        error: matches.length > 1
          ? `Section "${student.currently_section}" matches more than one grade. Include the grade in the section value.`
          : `Section "${student.currently_section}" was not found. Use an existing section name or "Grade 7 - Section Name".`,
      }, 400);
    }
    students.push({
      lrn: student.student_no,
      name: student.full_name,
      grade: matchedSection.grade,
      section: matchedSection.section_name,
      academic_year: academicYear,
      row_number: student.row_number,
    });
  }

  const { data, error } = await adminClient.rpc('append_roster_import', {
    p_source_file: sourceFile,
    p_students: students,
    p_staff: [],
    p_rejected: rejected,
    p_actor_user_id: authData.user.id,
  });

  if (error) {
    console.error('Current roster import RPC failed:', error);
    return jsonResponse({ error: 'Import failed. No partial roster changes were committed.' }, 500);
  }
  return jsonResponse(data as Record<string, unknown>);
});
