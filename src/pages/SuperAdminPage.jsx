import React, { useEffect, useMemo, useState } from 'react';
import { Check, Clipboard, Database, History, KeyRound, Loader2, Shield, UserPlus, UserX } from 'lucide-react';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import EtlManagementPage from './EtlManagementPage';

const STAFF_ROLES = [
  { value: 'adviser', label: 'Adviser' },
  { value: 'principal', label: 'Principal' },
  { value: 'ministrong_tagasubaybay', label: 'Ministrong Tagasubaybay' },
  { value: 'osd', label: 'Office of Student Discipline' },
  { value: 'board_of_discipline', label: 'Board of Discipline' },
  { value: 'school_president', label: 'School President' },
];
const SECTION_ROLES = new Set(['adviser', 'principal', 'ministrong_tagasubaybay']);

const getInvocationErrorMessage = async (error) => {
  if (error?.context && typeof error.context.json === 'function') {
    try {
      const body = await error.context.json();
      if (typeof body?.error === 'string') return body.error;
    } catch {
      return error.message || 'The staff account request failed.';
    }
  }
  return error?.message || 'The staff account request failed.';
};

const getSectionLabel = (section) => (
  section.full_section_name || `${section.grade || section.grade_level} - ${section.section_name || section.name}`
);

const getStaffSections = (staff) => (staff.staff_section_assignments || [])
  .filter((assignment) => assignment.is_active !== false && (assignment.school_sections || assignment.sections))
  .map((assignment) => getSectionLabel(assignment.school_sections || assignment.sections));

function SuperAdminActivityHistory() {
  const [activity, setActivity] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const loadActivity = async () => {
      const { data, error } = await supabase
        .from('activity_logs')
        .select('id, created_at, user_email, user_role, action, entity_name, record_id, old_values, new_values')
        .order('id', { ascending: false })
        .limit(100);
      if (error) {
        setErrorMessage(`Could not load Super Admin activity history: ${error.message}`);
      } else {
        setActivity(data || []);
      }
      setIsLoading(false);
    };
    void loadActivity();
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-5 dark:border-slate-800">
        <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Super Admin activity history</h2>
        <p className="mt-1 text-sm text-slate-500">Latest staff account and student roster management actions.</p>
      </div>
      {errorMessage ? (
        <p role="alert" className="m-5 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">{errorMessage}</p>
      ) : isLoading ? (
        <p className="p-6 text-sm text-slate-500">Loading activity history…</p>
      ) : activity.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">No recorded Super Admin activity yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
              <tr>
                <th className="p-3">Timestamp</th>
                <th className="p-3">Administrator</th>
                <th className="p-3">Action</th>
                <th className="p-3">Record</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {activity.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap p-3 text-xs">{new Date(entry.created_at).toLocaleString()}</td>
                  <td className="p-3">{entry.user_email || 'Super Admin'}</td>
                  <td className="p-3 font-bold">{entry.action}</td>
                  <td className="p-3">{entry.entity_name || '—'} {entry.record_id || ''}</td>
                  <td className="max-w-sm truncate p-3 font-mono text-xs">
                    {JSON.stringify(entry.new_values || entry.old_values || {})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function SuperAdminPage() {
  const { currentUser, logout } = useAuth();
  const [activePanel, setActivePanel] = useState('staff');
  const [staff, setStaff] = useState([]);
  const [sections, setSections] = useState([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('adviser');
  const [sectionIds, setSectionIds] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [auditWarning, setAuditWarning] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [pendingDeactivation, setPendingDeactivation] = useState(null);
  const [deactivatingId, setDeactivatingId] = useState(null);

  const activeStaff = useMemo(() => staff.filter((account) => account.is_active), [staff]);
  const inactiveStaff = useMemo(() => staff.filter((account) => !account.is_active), [staff]);
  const needsSections = SECTION_ROLES.has(role);

  const loadDirectory = async () => {
    setIsLoading(true);
    setErrorMessage('');
    const { data, error } = await supabase.functions.invoke('manage-staff', {
      body: { action: 'list' },
    });
    if (error) {
      setErrorMessage(`Could not load staff accounts: ${await getInvocationErrorMessage(error)}`);
      setIsLoading(false);
      return;
    }
    setStaff(data.staff || []);
    setSections(data.sections || []);
    setIsLoading(false);
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      setIsLoading(true);
      setErrorMessage('');
      const { data, error } = await supabase.functions.invoke('manage-staff', {
        body: { action: 'list' },
      });
      if (!active) return;
      if (error) {
        setErrorMessage(`Could not load staff accounts: ${await getInvocationErrorMessage(error)}`);
      } else {
        setStaff(data.staff || []);
        setSections(data.sections || []);
      }
      setIsLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const handleSectionChange = (event) => {
    const selected = Array.from(event.target.selectedOptions, (option) => option.value);
    setSectionIds(selected);
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setAuditWarning('');
    setTemporaryPassword('');
    setPasswordCopied(false);

    if (needsSections && sectionIds.length === 0) {
      setErrorMessage('Choose at least one section for this position.');
      return;
    }

    setIsSaving(true);
    const { data, error } = await supabase.functions.invoke('manage-staff', {
      body: {
        action: 'create',
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
        sectionIds,
      },
    });
    setIsSaving(false);

    if (error) {
      setErrorMessage(`Could not create the account: ${await getInvocationErrorMessage(error)}`);
      return;
    }

    setTemporaryPassword(data.temporaryPassword);
    setAuditWarning(data.auditWarning || '');
    setName('');
    setEmail('');
    setRole('adviser');
    setSectionIds([]);
    await loadDirectory();
  };

  const handleDeactivate = async () => {
    if (!pendingDeactivation) return;
    const target = pendingDeactivation;
    setPendingDeactivation(null);
    setDeactivatingId(target.id);
    setErrorMessage('');
    setAuditWarning('');
    const { data, error } = await supabase.functions.invoke('manage-staff', {
      body: { action: 'deactivate', profileId: target.id },
    });
    setDeactivatingId(null);
    if (error) {
      setErrorMessage(`Could not deactivate ${target.name}: ${await getInvocationErrorMessage(error)}`);
      return;
    }
    setAuditWarning(data?.auditWarning || '');
    await loadDirectory();
  };

  const handleCopyPassword = async () => {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      setPasswordCopied(true);
    } catch (error) {
      setErrorMessage(`Could not copy the temporary password: ${error.message}`);
    }
  };

  const renderStaffRows = (accounts, inactive = false) => {
    if (!accounts.length) {
      return (
        <p className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No {inactive ? 'inactive' : 'active'} staff accounts.
        </p>
      );
    }

    return (
      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        {accounts.map((account) => (
          <div key={account.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold text-slate-900 dark:text-white">{account.name}</p>
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                  inactive
                    ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                }`}>
                  {inactive ? 'Inactive' : 'Active'}
                </span>
                {account.must_change_password && (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    Must change password
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-sm text-slate-600 dark:text-slate-400">{account.email}</p>
              <p className="mt-1 text-sm font-semibold text-blue-800 dark:text-blue-300">
                {STAFF_ROLES.find((staffRole) => staffRole.value === account.role)?.label || account.role}
              </p>
              {getStaffSections(account).length > 0 && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Sections: {getStaffSections(account).join(', ')}
                </p>
              )}
            </div>
            {!inactive && (
              <button
                type="button"
                onClick={() => setPendingDeactivation(account)}
                disabled={deactivatingId === account.id}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-rose-300 px-3 py-2 text-sm font-bold text-rose-800 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
              >
                {deactivatingId === account.id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <UserX className="h-4 w-4" />}
                Deactivate
              </button>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 dark:bg-slate-950 sm:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-blue-100 p-3 text-blue-900 dark:bg-blue-950 dark:text-blue-300">
                <Shield className="h-6 w-6" />
              </span>
              <div>
                <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white">Super Admin Console</h1>
                <p className="text-sm text-slate-600 dark:text-slate-400">Super Admin · {currentUser?.name}</p>
              </div>
            </div>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
              Manage staff access, the current enrolled student roster, and Super Admin activity history.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void logout(); }}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Sign out
          </button>
        </header>

        <nav className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800" aria-label="Super Admin management">
          {[
            { id: 'staff', label: 'Staff accounts', icon: UserPlus },
            { id: 'students', label: 'Student enrollment', icon: Database },
            { id: 'history', label: 'Activity history', icon: History },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActivePanel(id)}
              className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold ${
                activePanel === id
                  ? 'border-blue-900 text-blue-900 dark:border-blue-400 dark:text-blue-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </nav>

        {activePanel === 'staff' && (
          <>
        {auditWarning && (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            {auditWarning}
          </p>
        )}
        {errorMessage && (
          <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm font-semibold text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
            {errorMessage}
          </p>
        )}

        {temporaryPassword && (
          <section aria-live="polite" className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <h2 className="font-extrabold">Copy this temporary password now</h2>
                <p className="mt-1 text-sm">It is shown only once. Give it privately to the staff member; they must change it at first sign-in.</p>
                <code className="mt-3 block break-all rounded-lg border border-amber-300 bg-white p-3 font-mono text-base font-bold dark:border-amber-800 dark:bg-slate-900">
                  {temporaryPassword}
                </code>
              </div>
              <button
                type="button"
                onClick={() => { void handleCopyPassword(); }}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-amber-900 px-3 py-2 text-sm font-bold text-white hover:bg-amber-800"
              >
                {passwordCopied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                {passwordCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-5 flex items-center gap-3">
            <UserPlus className="h-5 w-5 text-blue-800 dark:text-blue-300" />
            <div>
              <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Create a staff account</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">The password is generated securely and must be changed on first login.</p>
            </div>
          </div>
          <form onSubmit={handleCreate} className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
              Staff name
              <input
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </label>
            <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
              Staff email
              <input
                required
                type="email"
                maxLength={320}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              />
            </label>
            <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
              Position
              <select
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                  setSectionIds([]);
                }}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                {STAFF_ROLES.map((staffRole) => (
                  <option key={staffRole.value} value={staffRole.value}>{staffRole.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
              Assigned sections{needsSections ? ' (required)' : ' (optional)'}
              <select
                multiple
                value={sectionIds}
                onChange={handleSectionChange}
                className="mt-1.5 h-28 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                {sections.map((section) => (
                  <option key={section.id} value={String(section.id)}>{getSectionLabel(section)}</option>
                ))}
              </select>
              <span className="mt-1 block font-normal text-slate-500 dark:text-slate-400">
                Hold Ctrl (Windows) or Command (Mac) to select more than one.
              </span>
            </label>
            <button
              type="submit"
              disabled={isSaving || isLoading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#0f2444] px-4 py-3 font-bold text-white hover:bg-[#1b365d] disabled:cursor-not-allowed disabled:opacity-60 md:col-span-2"
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSaving ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Active staff</h2>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              {activeStaff.length}
            </span>
          </div>
          {isLoading
            ? <p className="flex items-center gap-2 py-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading staff…</p>
            : renderStaffRows(activeStaff)}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Inactive staff</h2>
            <span className="rounded-full bg-slate-200 px-3 py-1 text-sm font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {inactiveStaff.length}
            </span>
          </div>
          {isLoading
            ? <p className="flex items-center gap-2 py-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading staff…</p>
            : renderStaffRows(inactiveStaff, true)}
        </section>
          </>
        )}

        {activePanel === 'students' && <EtlManagementPage />}
        {activePanel === 'history' && <SuperAdminActivityHistory />}
      </div>

      <ConfirmDialog
        isOpen={Boolean(pendingDeactivation)}
        onClose={() => setPendingDeactivation(null)}
        onConfirm={() => { void handleDeactivate(); }}
        title="Deactivate staff account?"
        message={`${pendingDeactivation?.name || 'This staff member'} will no longer be able to sign in. Their profile and school records will be kept.`}
        confirmLabel="Deactivate account"
        cancelLabel="Keep active"
        isDestructive
      />
    </main>
  );
}
