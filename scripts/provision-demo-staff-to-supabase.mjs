import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { INITIAL_USERS } from '../src/data/initialSeedData.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialsPath = path.join(root, 'supabase', 'onboarding-credentials.local.json');
const envPath = path.join(root, '.env.local');
const expectedRoles = new Set([
  'adviser',
  'board_of_discipline',
  'ministrong_tagasubaybay',
  'osd',
  'principal',
  'school_president',
]);

const stop = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const checkServiceRoleAccess = async (admin) => {
  try {
    const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (!error) return {};
    if (/invalid api key|jwt.*(invalid|malformed)|unauthorized/i.test(error.message)) {
      return {
        error: 'Supabase rejected the admin key. Use the project’s service_role secret from Project Settings → API Keys; do not use the anon/publishable key.',
      };
    }
    return {
      error: `Supabase Auth admin check failed: ${error.message}`,
    };
  } catch (error) {
    const cause = error.cause?.code || error.cause?.message;
    return {
      error: `Could not reach the Supabase Auth admin API${cause ? ` (${cause})` : ''}. Verify internet/VPN/proxy access, then try again.`,
    };
  }
};

const sectionMatchesAssignment = (section, user) => {
  const scope = (user.assigned_section || '').trim();
  if (!scope) return false;
  if (['all sections (campus-wide)', 'all departments', 'all grades', 'junior & senior high school']
    .includes(scope.toLowerCase())) return true;

  const gradeNumber = Number(section.grade.match(/\d+/)?.[0]);
  const gradeOnly = scope.match(/^Grade\s+(\d+)$/i);
  if (gradeOnly) return gradeNumber === Number(gradeOnly[1]);

  const gradeRange = scope.match(/^Grades\s+(\d+)\s*-\s*(\d+)$/i);
  if (gradeRange) return gradeNumber >= Number(gradeRange[1]) && gradeNumber <= Number(gradeRange[2]);

  const exactSection = scope.match(/^Grade\s+(\d+)\s*-\s*(.+)$/i);
  if (exactSection) {
    return gradeNumber === Number(exactSection[1])
      && section.section_name.trim().toLowerCase() === exactSection[2].trim().toLowerCase();
  }
  return false;
};

if (process.argv[2] !== '--apply') {
  console.log('Dry run only. Re-run with --apply to create Supabase Auth users and link staff profiles.');
  console.log(`Seed staff accounts: ${INITIAL_USERS.length}`);
  console.log('Each new account receives a different random temporary password and must change it at first sign-in.');
  console.log('Existing staff profile and section rows are preserved.');
  process.exit(0);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  stop('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the process environment. Never put the service-role key in the frontend or commit it.');
} else if (await readFile(credentialsPath).then(() => true).catch(() => false)) {
  stop(`Refusing to overwrite existing credentials file: ${credentialsPath}`);
} else {
  let urlHost = '';
  try {
    urlHost = new URL(supabaseUrl).host;
  } catch {
    stop('SUPABASE_URL is invalid. Use the project URL from Supabase Settings → API.');
  }

  if (!process.exitCode) {
  const invalidSeed = INITIAL_USERS.find((user) => (
    !user.id || !user.name || !user.email || !expectedRoles.has(user.role)
  ));
  const emails = INITIAL_USERS.map((user) => user.email.trim().toLowerCase());
  if (invalidSeed || new Set(emails).size !== emails.length) {
    stop('The seed account list contains an invalid role, missing account field, or duplicate email. No accounts were created.');
  } else {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const adminAccess = await checkServiceRoleAccess(admin);
    if (adminAccess.error) {
      stop(adminAccess.error);
    }

    if (!process.exitCode) {
    const legacySchemaProbe = await admin.from('users').select('auth_user_id, avatar_url').limit(0);
    const isLegacySchema = !legacySchemaProbe.error;
    if (
      legacySchemaProbe.error
      && !(
        /auth_user_id|avatar_url/i.test(legacySchemaProbe.error.message)
        && /(does not exist|could not find|schema cache)/i.test(legacySchemaProbe.error.message)
      )
    ) {
      stop(`Supabase Auth is reachable at ${urlHost}, but the users schema query failed: ${legacySchemaProbe.error.message}`);
    }

    const profilesResult = await admin
      .from('users')
      .select(isLegacySchema
        ? 'id, auth_user_id, email, name, role, is_active, must_change_password'
        : 'id, email, is_active, must_change_password')
      .in('email', emails);

    const sectionsResult = profilesResult.error || isLegacySchema
      ? { data: [], error: null }
      : await admin
        .from('school_sections')
        .select('id, grade, section_name, academic_year');

    if (profilesResult.error) {
      const schemaIssue = profilesResult.error.code === '42703'
        || profilesResult.error.code === 'PGRST204'
        || /must_change_password|column.*(not exist|schema cache)/i.test(profilesResult.error.message);
      stop(schemaIssue
        ? `Connected to Supabase, but the staff onboarding schema is missing or incompatible. Run 20261107215000_secure_staff_auth_onboarding.sql in the SQL Editor. Details: ${profilesResult.error.message}`
        : `Connected to Supabase Auth at ${urlHost}, but could not read public.users. Check the service_role key and table/schema permissions. Details: ${profilesResult.error.message}`);
    } else if (sectionsResult.error) {
      stop(`Could not inspect school_sections before provisioning: ${sectionsResult.error.message}`);
    } else {
      let existingAuthUsers = [];
      for (let page = 1; ; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) {
          stop(`Could not check existing Supabase Auth accounts: ${error.message}`);
          break;
        }
        existingAuthUsers = existingAuthUsers.concat(data.users);
        if (data.users.length < 1000) break;
      }

      if (!process.exitCode) {
        const existingAuthByEmail = new Map(
          existingAuthUsers
            .filter((user) => user.email)
            .map((user) => [user.email.toLowerCase(), user])
        );
        const profilesByEmail = new Map();
        for (const profile of profilesResult.data || []) {
          const email = profile.email.toLowerCase();
          const matchingProfiles = profilesByEmail.get(email) || [];
          matchingProfiles.push(profile);
          profilesByEmail.set(email, matchingProfiles);
        }

        const missingProfiles = isLegacySchema
          ? emails.filter((email) => !profilesByEmail.has(email))
          : [];
        const duplicateProfiles = isLegacySchema
          ? [...profilesByEmail.entries()].filter(([, matches]) => matches.length !== 1).map(([email]) => email)
          : [];
        const roleMismatches = isLegacySchema
          ? INITIAL_USERS.filter((seed) => {
            const matches = profilesByEmail.get(seed.email.trim().toLowerCase()) || [];
            return matches.length === 1 && matches[0].role !== seed.role;
          }).map((seed) => seed.email)
          : [];
        const inactiveProfiles = isLegacySchema
          ? INITIAL_USERS.filter((seed) => {
            const matches = profilesByEmail.get(seed.email.trim().toLowerCase()) || [];
            return matches.length === 1 && !matches[0].is_active;
          }).map((seed) => seed.email)
          : [];
        const linkedProfiles = isLegacySchema
          ? INITIAL_USERS.filter((seed) => {
            const matches = profilesByEmail.get(seed.email.trim().toLowerCase()) || [];
            return matches.length === 1 && matches[0].auth_user_id;
          }).map((seed) => seed.email)
          : [];

        if (
          missingProfiles.length
          || duplicateProfiles.length
          || roleMismatches.length
          || inactiveProfiles.length
          || linkedProfiles.length
        ) {
          stop([
            missingProfiles.length ? `Missing existing staff profiles: ${missingProfiles.join(', ')}` : '',
            duplicateProfiles.length ? `Duplicate existing staff profiles: ${duplicateProfiles.join(', ')}` : '',
            roleMismatches.length ? `Roles differ from the seed directory: ${roleMismatches.join(', ')}` : '',
            inactiveProfiles.length ? `Inactive profiles must not receive new accounts: ${inactiveProfiles.join(', ')}` : '',
            linkedProfiles.length ? `Profiles already linked to Auth accounts: ${linkedProfiles.join(', ')}` : '',
          ].filter(Boolean).join('\n'));
        } else {
          const collisions = emails.filter((email) => (
            existingAuthByEmail.has(email)
            || (!isLegacySchema && profilesByEmail.has(email))
          ));

          if (collisions.length) {
            stop(`No accounts were changed. Auth accounts already exist for: ${collisions.join(', ')}. Use a password-reset flow for those accounts instead.`);
          } else {
            const createdUserIds = [];
            const linkedProfileRows = [];
            const credentials = [];
            const assignmentWarnings = [];
            let assignmentsCreated = 0;
            let provisioningError = null;
            const rollbackCreatedAccounts = async () => {
              const rollbackErrors = [];
              for (const profile of linkedProfileRows.slice().reverse()) {
                const { error } = await admin
                  .from('users')
                  .update({ auth_user_id: null, must_change_password: profile.mustChangePassword })
                  .eq('id', profile.id)
                  .eq('auth_user_id', profile.authUserId);
                if (error) rollbackErrors.push(`profile ${profile.id}: ${error.message}`);
              }
              for (const userId of createdUserIds.slice().reverse()) {
                const { error } = await admin.auth.admin.deleteUser(userId);
                if (error) rollbackErrors.push(`${userId}: ${error.message}`);
              }
              return rollbackErrors;
            };

            for (const seedProfile of INITIAL_USERS) {
              const profileEmail = seedProfile.email.trim().toLowerCase();
              const temporaryPassword = `${randomBytes(24).toString('base64url')}Aa1!`;
              const { data, error } = await admin.auth.admin.createUser({
                email: profileEmail,
                password: temporaryPassword,
                email_confirm: true,
                user_metadata: { name: seedProfile.name },
              });

              if (error || !data.user) {
                provisioningError = `Could not create ${profileEmail}: ${error?.message || 'Supabase returned no Auth user.'}`;
                break;
              }
              createdUserIds.push(data.user.id);

              if (isLegacySchema) {
                const profile = profilesByEmail.get(profileEmail)[0];
                if (profile.auth_user_id) {
                  provisioningError = `${profileEmail} already has an Auth link. No existing profile was changed.`;
                  break;
                }

                const { data: linkedProfiles, error: linkError } = await admin
                  .from('users')
                  .update({
                    auth_user_id: data.user.id,
                    must_change_password: true,
                  })
                  .eq('id', profile.id)
                  .eq('email', profileEmail)
                  .eq('is_active', true)
                  .is('auth_user_id', null)
                  .select('id');

                if (linkError || linkedProfiles?.length !== 1) {
                  provisioningError = `Could not link the new Auth account to ${profileEmail}: ${linkError?.message || 'The profile was inactive, already linked, or not unique.'}`;
                  break;
                }
                linkedProfileRows.push({
                  id: profile.id,
                  authUserId: data.user.id,
                  mustChangePassword: profile.must_change_password,
                });
              } else {
                const profileRow = {
                  id: data.user.id,
                  email: profileEmail,
                  name: seedProfile.name,
                  role: seedProfile.role,
                  title: seedProfile.title || null,
                  department: seedProfile.department || null,
                  avatar: seedProfile.avatar || null,
                  is_active: true,
                  must_change_password: true,
                };
                const { error: profileWriteError } = await admin.from('users').insert(profileRow);

                if (profileWriteError) {
                  provisioningError = `Could not save the staff profile for ${profileEmail}: ${profileWriteError.message}`;
                  break;
                }

                const matchingSections = (sectionsResult.data || [])
                  .filter((section) => sectionMatchesAssignment(section, seedProfile));
                if (['adviser', 'ministrong_tagasubaybay', 'principal'].includes(seedProfile.role)) {
                  if (!matchingSections.length) {
                    assignmentWarnings.push(`${profileEmail}: no existing school section matched "${seedProfile.assigned_section}".`);
                  } else {
                    const { error: assignmentError } = await admin
                      .from('staff_section_assignments')
                      .insert(matchingSections.map((section) => ({
                        user_id: data.user.id,
                        section_id: section.id,
                      })));
                    if (assignmentError) {
                      provisioningError = `Could not create section assignments for ${profileEmail}: ${assignmentError.message}`;
                      break;
                    }
                    assignmentsCreated += matchingSections.length;
                  }
                }
              }

              credentials.push({
                username: profileEmail,
                name: seedProfile.name,
                role: seedProfile.role,
                temporary_password: temporaryPassword,
                change_password_on_first_login: true,
              });
            }

            if (provisioningError) {
              const rollbackErrors = await rollbackCreatedAccounts();
              stop(`${provisioningError} Newly created Auth users were rolled back.${rollbackErrors.length ? ` Rollback errors: ${rollbackErrors.join('; ')}` : ''}`);
            } else {
              const credentialDocument = {
                created_at: new Date().toISOString(),
                warning: 'Contains one-time passwords. Distribute each credential privately to its named staff member, then securely delete this file.',
                accounts: credentials,
              };
              try {
                await writeFile(credentialsPath, `${JSON.stringify(credentialDocument, null, 2)}\n`, {
                  encoding: 'utf8',
                  flag: 'wx',
                  mode: 0o600,
                });
              } catch (error) {
                const rollbackErrors = await rollbackCreatedAccounts();
                stop(`Could not save the one-time passwords; created accounts were rolled back. ${error.message}${rollbackErrors.length ? ` Rollback errors: ${rollbackErrors.join('; ')}` : ''}`);
              }

              if (!process.exitCode) {
                try {
                let envContents = '';
                try {
                  envContents = await readFile(envPath, 'utf8');
                } catch (error) {
                  if (error.code !== 'ENOENT') throw error;
                }
                const demoModeLine = 'VITE_HAYAGSYNC_DEMO_MODE=false';
                const updatedEnv = /^VITE_HAYAGSYNC_DEMO_MODE=.*$/m.test(envContents)
                  ? envContents.replace(/^VITE_HAYAGSYNC_DEMO_MODE=.*$/m, demoModeLine)
                  : `${envContents}${envContents && !envContents.endsWith('\n') ? '\n' : ''}${demoModeLine}\n`;
                await writeFile(envPath, updatedEnv, 'utf8');
                console.log(`Created ${credentials.length} Supabase staff accounts with unique temporary passwords.`);
                if (!isLegacySchema) console.log(`Created ${assignmentsCreated} normalized staff-section assignments.`);
                if (assignmentWarnings.length) {
                  console.warn(`Some accounts have no matching current school sections:\n${assignmentWarnings.join('\n')}`);
                  console.warn('After the roster sections exist, assign these users to sections in Supabase before relying on section-scoped access.');
                }
                console.log(`Private onboarding credentials: ${credentialsPath}`);
                console.log('Demo mode is now disabled in .env.local. Restart Vite before signing in.');
                console.log('These seed usernames are not verified mailboxes; password recovery by email will not work. Keep an administrator-managed recovery process.');
                } catch (error) {
                  stop(`Accounts and one-time passwords were saved, but .env.local could not be updated: ${error.message}. Keep the credentials file and set VITE_HAYAGSYNC_DEMO_MODE=false manually.`);
                }
              }
            }
          }
          }
          }
        }
      }
    }
  }
}
