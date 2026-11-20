import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialsPath = path.join(root, 'supabase', 'super-admin-credentials.local.json');
const email = (process.argv[2] || '').trim().toLowerCase();
const name = (process.argv[3] || '').trim();
const applyChanges = process.argv.includes('--apply');
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let credentialsFileExists = false;

const stop = (message) => {
  console.error(message);
  process.exitCode = 1;
};

try {
  await access(credentialsPath);
  credentialsFileExists = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 200) {
  stop('Provide a valid email address and a name up to 200 characters.');
} else if (!supabaseUrl || !serviceRoleKey) {
  stop('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the process environment.');
} else if (credentialsFileExists) {
  stop(`Refusing to overwrite the existing credentials file: ${credentialsPath}`);
} else {
  let url;
  try {
    url = new URL(supabaseUrl);
  } catch {
    stop('SUPABASE_URL is invalid.');
  }

  if (!process.exitCode && (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co'))) {
    stop('SUPABASE_URL must be an HTTPS Supabase project URL.');
  }

  if (!process.exitCode) {
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error: schemaError } = await admin.from('users').select('auth_user_id').limit(0);
    if (schemaError) {
      stop(`Could not verify the legacy staff schema. Apply the Super Admin migration first: ${schemaError.message}`);
    } else {
      const { data: profiles, error: profileError } = await admin
        .from('users')
        .select('id')
        .eq('email', email);
      if (profileError) {
        stop(`Could not check for an existing staff profile: ${profileError.message}`);
      } else if (profiles.length) {
        stop('A profile already exists for this email. Use a new email for the Super Admin account.');
      } else {
        const { data: activeAdmins, error: activeAdminsError } = await admin
          .from('users')
          .select('id')
          .eq('role', 'super_admin')
          .eq('is_active', true)
          .limit(1);
        if (activeAdminsError) {
          stop(`Could not check for an existing active Super Admin: ${activeAdminsError.message}`);
        } else if (activeAdmins.length) {
          stop('An active Super Admin already exists. Only one active Super Admin account is allowed.');
        } else {
          const { data: authUsers, error: authError } = await admin.auth.admin.listUsers({
            page: 1,
            perPage: 1000,
          });
          if (authError) {
            stop(`Could not check Supabase Auth accounts: ${authError.message}`);
          } else if (authUsers.users.some((user) => user.email?.toLowerCase() === email)) {
            stop('A Supabase Auth account already exists for this email. Use a new email.');
          } else if (!applyChanges) {
            console.log(`Ready to create a Super Admin account for ${email} (${name}).`);
            console.log('Dry run only. Confirm with CREATE through scripts/create-super-admin.ps1.');
          } else {
            const temporaryPassword = `${randomBytes(24).toString('base64url')}Aa1!`;
            const { data: profile, error: profileWriteError } = await admin
              .from('users')
              .insert({
                auth_user_id: null,
                email,
                name,
                role: 'super_admin',
                is_active: true,
                must_change_password: true,
              })
              .select('id')
              .single();

            if (profileWriteError || !profile) {
              stop(`Could not create the Super Admin profile: ${profileWriteError?.message || 'No profile was returned.'}`);
            } else {
              const { data: createdAuth, error: createAuthError } = await admin.auth.admin.createUser({
                email,
                password: temporaryPassword,
                email_confirm: true,
                user_metadata: { name },
              });

              if (createAuthError || !createdAuth.user) {
                const { error: profileRollbackError } = await admin
                  .from('users')
                  .delete()
                  .eq('id', profile.id)
                  .is('auth_user_id', null);
                stop(`Could not create the Super Admin login: ${createAuthError?.message || 'Supabase returned no Auth user.'}${profileRollbackError ? ` Profile rollback also failed: ${profileRollbackError.message}` : ''}`);
              } else {
                const { data: linkedProfile, error: linkError } = await admin
                  .from('users')
                  .update({ auth_user_id: createdAuth.user.id })
                  .eq('id', profile.id)
                  .is('auth_user_id', null)
                  .select('id')
                  .single();

                if (linkError || !linkedProfile) {
                  const { error: profileRollbackError } = await admin.from('users').delete().eq('id', profile.id);
                  const { error: authRollbackError } = await admin.auth.admin.deleteUser(createdAuth.user.id);
                  stop(`Could not link the Super Admin profile to its Auth account: ${linkError?.message || 'No linked profile was returned.'}${profileRollbackError ? ` Profile rollback also failed: ${profileRollbackError.message}` : ''}${authRollbackError ? ` Auth rollback also failed: ${authRollbackError.message}` : ''}`);
                } else {
                  try {
                    await writeFile(credentialsPath, `${JSON.stringify({
                      created_at: new Date().toISOString(),
                      warning: 'Contains a one-time password. Keep private and delete after setting the new password.',
                      account: { email, name, temporary_password: temporaryPassword },
                    }, null, 2)}\n`, {
                      encoding: 'utf8',
                      flag: 'wx',
                      mode: 0o600,
                    });
                    console.log(`Created the Super Admin profile (${linkedProfile.id}).`);
                    console.log(`One-time credentials saved locally: ${credentialsPath}`);
                    console.log('Sign in once and set a new password immediately.');
                  } catch (error) {
                    const { error: profileRollbackError } = await admin.from('users').delete().eq('id', linkedProfile.id);
                    const { error: authRollbackError } = await admin.auth.admin.deleteUser(createdAuth.user.id);
                    stop(`Could not save the one-time password; account creation was rolled back. ${error.message}${profileRollbackError ? ` Profile rollback also failed: ${profileRollbackError.message}` : ''}${authRollbackError ? ` Auth rollback also failed: ${authRollbackError.message}` : ''}`);
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
