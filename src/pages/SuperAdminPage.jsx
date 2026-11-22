import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, Clipboard, Database, Download, Eye, EyeOff, History, KeyRound, Loader2,
  RefreshCw, Search, Shield, Shuffle, UserPlus, UserX,
} from 'lucide-react';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useAuth } from '../context/AuthContext';
import { INITIAL_USERS } from '../data/initialSeedData';
import { supabase } from '../lib/supabaseClient';
import EtlManagementPage from './EtlManagementPage';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const STAFF_ROLES = [
  { value: 'adviser', label: 'Adviser' },
  { value: 'principal', label: 'Principal' },
  { value: 'ministrong_tagasubaybay', label: 'Ministrong Tagasubaybay' },
  { value: 'osd', label: 'Office of Student Discipline' },
  { value: 'board_of_discipline', label: 'Board of Discipline' },
  { value: 'school_president', label: 'School President' },
];
const SECTION_ROLES = new Set(['adviser', 'principal', 'ministrong_tagasubaybay']);

const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;

const PANELS = [
  { id: 'staff', label: 'Staff accounts', icon: UserPlus },
  { id: 'students', label: 'Student enrollment', icon: Database },
  { id: 'history', label: 'Activity history', icon: History },
];

const INPUT_CLASS =
  'mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:focus:ring-blue-950';
const CARD_CLASS =
  'rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

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

const getRoleLabel = (roleValue) => (
  STAFF_ROLES.find((staffRole) => staffRole.value === roleValue)?.label || roleValue
);

const getLatestSections = (sections) => {
  const academicYears = [...new Set(sections.map((section) => section.academic_year).filter(Boolean))].sort();
  if (!academicYears.length) return sections;
  const latestAcademicYear = academicYears[academicYears.length - 1];
  return sections.filter((section) => section.academic_year === latestAcademicYear);
};

const randomize = (items) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomValue = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / (index + 1)) * (index + 1);
    do { crypto.getRandomValues(randomValue); } while (randomValue[0] >= limit);
    const targetIndex = randomValue[0] % (index + 1);
    [shuffled[index], shuffled[targetIndex]] = [shuffled[targetIndex], shuffled[index]];
  }
  return shuffled;
};

const getRoleSectionIds = (user, availableSections) => {
  if (!SECTION_ROLES.has(user.role)) return [];
  const assignment = user.assigned_section || '';
  const range = assignment.match(/grades?\s*(\d+)\s*[-–]\s*(\d+)/i);
  const grade = assignment.match(/grade\s*(\d+)/i);
  if (/all departments|all grades|junior|senior/i.test(assignment)) {
    if (range) {
      const firstGrade = Number(range[1]);
      const lastGrade = Number(range[2]);
      return availableSections
        .filter((section) => {
          const sectionGrade = Number(String(section.grade).match(/\d+/)?.[0]);
          return sectionGrade >= firstGrade && sectionGrade <= lastGrade;
        })
        .map((section) => String(section.id));
    }
    return availableSections.map((section) => String(section.id));
  }
  if (grade) {
    return availableSections
      .filter((section) => Number(String(section.grade).match(/\d+/)?.[0]) === Number(grade[1]))
      .map((section) => String(section.id));
  }
  return [];
};

const matchesStaffSearch = (account, query) => {
  if (!query) return true;
  return [account.name, account.username, account.email, getRoleLabel(account.role), ...getStaffSections(account)]
    .some((value) => String(value || '').toLowerCase().includes(query));
};

/** Suggest a username from an email address (the part before the @). */
const suggestUsername = (emailValue) => (
  emailValue.split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 30)
);

/** Returns an error string, or '' if the password is acceptable. */
const getPasswordError = (value) => {
  if (value.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) {
    return 'Password must include an uppercase letter, a lowercase letter, and a number.';
  }
  return '';
};

/** Cryptographically random password; avoids look-alike characters (0/O, 1/l/I). */
const generatePassword = (length = 12) => {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;
  const randomInt = (max) => {
    const buffer = new Uint32Array(1);
    const limit = Math.floor(0xffffffff / max) * max;
    do { crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
    return buffer[0] % max;
  };
  const chars = [
    lower[randomInt(lower.length)],
    upper[randomInt(upper.length)],
    digits[randomInt(digits.length)],
  ];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

/* -------------------------------------------------------------------------- */
/* Activity history                                                           */
/* -------------------------------------------------------------------------- */

function SuperAdminActivityHistory() {
  const [activity, setActivity] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  const loadActivity = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');
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
  }, []);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5 dark:border-slate-800">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Super Admin activity history</h2>
          <p className="mt-1 text-sm text-slate-500">Latest staff account and student roster management actions.</p>
        </div>
        <button
          type="button"
          onClick={() => { void loadActivity(); }}
          disabled={isLoading}
          aria-label="Refresh activity history"
          title="Refresh activity history"
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
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
              {activity.map((entry) => {
                const details = JSON.stringify(entry.new_values || entry.old_values || {});
                return (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap p-3 text-xs">{new Date(entry.created_at).toLocaleString()}</td>
                    <td className="p-3">{entry.user_email || 'Super Admin'}</td>
                    <td className="p-3 font-bold">{entry.action}</td>
                    <td className="p-3">{entry.entity_name || '—'} {entry.record_id || ''}</td>
                    <td className="max-w-sm truncate p-3 font-mono text-xs" title={details}>{details}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

function Banner({ tone, role, children }) {
  const tones = {
    error: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200',
    warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
  };
  return (
    <p role={role} className={`rounded-lg border p-4 text-sm font-semibold ${tones[tone]}`}>{children}</p>
  );
}

function CredentialsCard({ credentials, copied, onCopy, onDismiss }) {
  return (
    <section aria-live="polite" className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-extrabold">Account created for {credentials.name}</h2>
          <p className="mt-1 text-sm">
            Copy these login details now — the password is shown only once. Give it privately to the staff member;
            they must change it at first sign-in. They can sign in with either the username or the email.
          </p>
          <dl className="mt-3 grid gap-2 rounded-lg border border-amber-300 bg-white p-3 font-mono text-sm dark:border-amber-800 dark:bg-slate-900 sm:grid-cols-[auto,1fr]">
            <dt className="font-bold">Username</dt>
            <dd className="break-all">{credentials.username}</dd>
            <dt className="font-bold">Email</dt>
            <dd className="break-all">{credentials.email}</dd>
            <dt className="font-bold">Temporary password</dt>
            <dd className="break-all font-bold">{credentials.password}</dd>
          </dl>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-900 px-3 py-2 text-sm font-bold text-white hover:bg-amber-800"
          >
            {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg border border-amber-400 px-3 py-2 text-sm font-bold hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}

function StaffRow({ account, inactive, isDeactivating, onDeactivate }) {
  const sectionLabels = getStaffSections(account);
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
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
        {account.username && (
          <p className="mt-1 truncate text-sm font-medium text-slate-700 dark:text-slate-300">@{account.username}</p>
        )}
        <p className="mt-1 truncate text-sm text-slate-600 dark:text-slate-400">{account.email}</p>
        <p className="mt-1 text-sm font-semibold text-blue-800 dark:text-blue-300">{getRoleLabel(account.role)}</p>
        {sectionLabels.length > 0 && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Sections: {sectionLabels.join(', ')}</p>
        )}
      </div>
      {!inactive && (
        <button
          type="button"
          onClick={() => onDeactivate(account)}
          disabled={isDeactivating}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-rose-300 px-3 py-2 text-sm font-bold text-rose-800 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
        >
          {isDeactivating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
          Deactivate
        </button>
      )}
    </div>
  );
}

function StaffList({ accounts, inactive, isSearching, deactivatingId, onDeactivate }) {
  if (!accounts.length) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-5 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {isSearching ? 'No staff accounts match your search.' : `No ${inactive ? 'inactive' : 'active'} staff accounts.`}
      </p>
    );
  }
  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      {accounts.map((account) => (
        <StaffRow
          key={account.id}
          account={account}
          inactive={inactive}
          isDeactivating={deactivatingId === account.id}
          onDeactivate={onDeactivate}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function SuperAdminPage() {
  const { currentUser, logout } = useAuth();
  const [activePanel, setActivePanel] = useState('staff');

  // Directory data
  const [staff, setStaff] = useState([]);
  const [sections, setSections] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Create form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState('adviser');
  const [sectionIds, setSectionIds] = useState([]);
  const [sectionSearch, setSectionSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Feedback
  const [errorMessage, setErrorMessage] = useState('');
  const [auditWarning, setAuditWarning] = useState('');
  const [createdCredentials, setCreatedCredentials] = useState(null);
  const [credentialsCopied, setCredentialsCopied] = useState(false);
  const [bulkPlan, setBulkPlan] = useState(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [bulkResults, setBulkResults] = useState(null);

  // Directory UI
  const [staffSearch, setStaffSearch] = useState('');
  const [pendingDeactivation, setPendingDeactivation] = useState(null);
  const [deactivatingId, setDeactivatingId] = useState(null);

  const needsSections = SECTION_ROLES.has(role);
  const normalizedStaffSearch = staffSearch.trim().toLowerCase();
  const normalizedSectionSearch = sectionSearch.trim().toLowerCase();

  const activeStaff = useMemo(() => staff.filter((account) => account.is_active), [staff]);
  const inactiveStaff = useMemo(() => staff.filter((account) => !account.is_active), [staff]);
  const filteredActiveStaff = useMemo(
    () => activeStaff.filter((account) => matchesStaffSearch(account, normalizedStaffSearch)),
    [activeStaff, normalizedStaffSearch],
  );
  const filteredInactiveStaff = useMemo(
    () => inactiveStaff.filter((account) => matchesStaffSearch(account, normalizedStaffSearch)),
    [inactiveStaff, normalizedStaffSearch],
  );
  const filteredSections = useMemo(
    () => sections.filter((section) => getSectionLabel(section).toLowerCase().includes(normalizedSectionSearch)),
    [sections, normalizedSectionSearch],
  );
  const allVisibleSelected = filteredSections.length > 0
    && filteredSections.every((section) => sectionIds.includes(String(section.id)));

  /* ---- Data loading (single source of truth) ---- */

  const loadDirectory = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase.functions.invoke('manage-staff', {
      body: { action: 'list' },
    });
    if (error) {
      setErrorMessage(`Could not load staff accounts: ${await getInvocationErrorMessage(error)}`);
    } else {
      setStaff(data?.staff || []);
      setSections(data?.sections || []);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  /* ---- Form handlers ---- */

  const handleEmailChange = (value) => {
    setEmail(value);
    if (!usernameTouched) setUsername(suggestUsername(value));
  };

  const handleUsernameChange = (value) => {
    setUsernameTouched(true);
    setUsername(value.toLowerCase().replace(/\s/g, ''));
  };

  const handleRoleChange = (value) => {
    setRole(value);
    setSectionIds([]);
  };

  const handleGeneratePassword = () => {
    const generated = generatePassword();
    setPassword(generated);
    setConfirmPassword(generated);
    setShowPassword(true);
  };

  const toggleSection = (id, checked) => {
    setSectionIds((current) => (checked
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((selectedId) => selectedId !== id)));
  };

  const toggleAllVisibleSections = () => {
    const visibleIds = filteredSections.map((section) => String(section.id));
    setSectionIds((current) => (allVisibleSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])]));
  };

  const resetForm = () => {
    setName('');
    setEmail('');
    setUsername('');
    setUsernameTouched(false);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setRole('adviser');
    setSectionIds([]);
    setSectionSearch('');
  };

  const validateForm = (normalizedEmail, normalizedUsername) => {
    if (!name.trim() || !email.trim()) return 'Enter the staff member’s name and email address.';
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      return 'Username must be 3–30 characters: lowercase letters, numbers, dots, or underscores.';
    }
    const passwordError = getPasswordError(password);
    if (passwordError) return passwordError;
    if (password !== confirmPassword) return 'The passwords do not match. Re-enter the confirm password.';
    if (staff.some((account) => String(account.email || '').toLowerCase() === normalizedEmail)) {
      return 'An account with this email address already exists. Check the active and inactive staff lists.';
    }
    if (staff.some((account) => String(account.username || '').toLowerCase() === normalizedUsername)) {
      return 'This username is already taken. Choose a different one.';
    }
    if (needsSections && sectionIds.length === 0) return 'Choose at least one section for this position.';
    return '';
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setAuditWarning('');
    setCreatedCredentials(null);
    setCredentialsCopied(false);

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();

    const validationError = validateForm(normalizedEmail, normalizedUsername);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsSaving(true);
    const { data, error } = await supabase.functions.invoke('manage-staff', {
      body: {
        action: 'create',
        name: name.trim(),
        email: normalizedEmail,
        username: normalizedUsername,
        temporaryPassword: password,
        role,
        sectionIds,
      },
    });
    setIsSaving(false);

    if (error) {
      setErrorMessage(`Could not create the account: ${await getInvocationErrorMessage(error)}`);
      return;
    }

    setCreatedCredentials({
      name: name.trim(),
      email: normalizedEmail,
      username: data?.username || normalizedUsername,
      // Prefer what the server confirms; fall back to what the admin typed.
      password: data?.temporaryPassword || password,
    });
    setAuditWarning(data?.auditWarning || '');
    resetForm();
    await loadDirectory();
  };

  const handleCopyCredentials = async () => {
    if (!createdCredentials) return;
    const text = [
      `Name: ${createdCredentials.name}`,
      `Username: ${createdCredentials.username}`,
      `Email: ${createdCredentials.email}`,
      `Temporary password: ${createdCredentials.password}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCredentialsCopied(true);
    } catch (error) {
      setErrorMessage(`Could not copy the login details: ${error.message}`);
    }
  };

  const prepareBulkCreate = () => {
    setErrorMessage('');
    setAuditWarning('');
    setBulkResults(null);

    const existingEmails = new Set(staff.map((account) => String(account.email || '').toLowerCase()));
    const usersToCreate = INITIAL_USERS.filter(
      (user) => !existingEmails.has(String(user.email || '').toLowerCase()),
    );
    if (!usersToCreate.length) {
      setErrorMessage('All accounts from INITIAL_USERS already exist in the staff directory.');
      setBulkPlan(null);
      return;
    }

    const activeSections = getLatestSections(sections);
    const adviserUsers = usersToCreate.filter((user) => user.role === 'adviser');
    const adviserSectionNames = [...new Set(adviserUsers.map((user) => user.assigned_section))];
    const adviserSections = adviserSectionNames.map((sectionName) => {
      const matches = activeSections.filter(
        (section) => getSectionLabel(section).toLowerCase() === String(sectionName).toLowerCase(),
      );
      return { sectionName, section: matches.length === 1 ? matches[0] : null, matchCount: matches.length };
    });
    const invalidSection = adviserSections.find((entry) => !entry.section);
    if (invalidSection) {
      const reason = invalidSection.matchCount === 0 ? 'was not found' : 'matched more than one live section';
      setErrorMessage(`Cannot prepare the batch: "${invalidSection.sectionName}" ${reason}. Check the active school sections first.`);
      setBulkPlan(null);
      return;
    }
    const activeAdviserSections = new Set(staff
      .filter((account) => account.is_active && account.role === 'adviser')
      .flatMap((account) => [
        ...getStaffSections(account),
        ...String(account.assigned_section || '').split(',').map((label) => label.trim()),
      ])
      .map((label) => label.toLowerCase()));
    const unassignedAdviserSections = adviserSections
      .map((entry) => entry.section)
      .filter((section) => !activeAdviserSections.has(getSectionLabel(section).toLowerCase()));
    if (adviserUsers.length > unassignedAdviserSections.length) {
      setErrorMessage('Cannot assign a unique section to every adviser because there are fewer matching sections than advisers.');
      setBulkPlan(null);
      return;
    }

    const shuffledAdviserSections = randomize(unassignedAdviserSections);
    let adviserIndex = 0;
    const plan = usersToCreate.map((user) => {
      const sectionIds = user.role === 'adviser'
        ? [String(shuffledAdviserSections[adviserIndex++].id)]
        : getRoleSectionIds(user, activeSections);
      const assignedSections = activeSections
        .filter((section) => sectionIds.includes(String(section.id)))
        .map(getSectionLabel);
      return {
        name: user.name,
        email: user.email,
        role: user.role,
        sectionIds,
        assignedSections,
      };
    });
    const missingRequiredAssignment = plan.find(
      (account) => SECTION_ROLES.has(account.role) && account.sectionIds.length === 0,
    );
    if (missingRequiredAssignment) {
      setErrorMessage(`Cannot prepare the batch: no matching live sections were found for ${missingRequiredAssignment.name}.`);
      setBulkPlan(null);
      return;
    }

    setBulkPlan({
      accounts: plan,
      skipped: INITIAL_USERS.length - usersToCreate.length,
      academicYear: activeSections[0]?.academic_year || '',
    });
  };

  const handleBulkCreate = async () => {
    if (!bulkPlan) return;
    const { accounts, skipped } = bulkPlan;
    setBulkPlan(null);
    setBulkProgress({ current: 0, total: accounts.length });
    setBulkResults(null);
    setCreatedCredentials(null);
    setErrorMessage('');
    setAuditWarning('');

    const created = [];
    const failed = [];
    const warnings = [];
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index];
      setBulkProgress({ current: index + 1, total: accounts.length });
      let response;
      try {
        response = await supabase.functions.invoke('manage-staff', {
          body: {
            action: 'create',
            name: account.name,
            email: account.email,
            role: account.role,
            sectionIds: account.sectionIds,
          },
        });
      } catch (error) {
        failed.push({
          ...account,
          error: error instanceof Error && error.message
            ? error.message
            : 'The account request could not be completed.',
        });
        continue;
      }
      const { data, error } = response;

      if (error) {
        failed.push({
          ...account,
          error: await getInvocationErrorMessage(error),
        });
        continue;
      }
      if (!data?.temporaryPassword) {
        failed.push({
          ...account,
          error: 'The service did not return the temporary password. Check the staff directory before retrying.',
        });
        continue;
      }
      created.push({
        ...account,
        password: data.temporaryPassword,
      });
      if (data.auditWarning) warnings.push(data.auditWarning);
    }

    setBulkProgress(null);
    setBulkResults({ created, failed, skipped });
    setAuditWarning([...new Set(warnings)].join(' '));
    await loadDirectory();
  };

  const downloadBulkCredentials = () => {
    if (!bulkResults?.created.length) return;
    const rows = [
      ['Name', 'Email', 'Temporary password', 'Role', 'Assigned sections'],
      ...bulkResults.created.map((account) => [
        account.name,
        account.email,
        account.password,
        getRoleLabel(account.role),
        account.assignedSections.join('; '),
      ]),
    ];
    const csv = rows
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const file = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hayagsync-staff-temporary-credentials.csv';
    link.click();
    URL.revokeObjectURL(url);
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

  /* ---- Render ---- */

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
          {PANELS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActivePanel(id)}
              aria-current={activePanel === id ? 'page' : undefined}
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
            {auditWarning && <Banner tone="warning" role="status">{auditWarning}</Banner>}
            {errorMessage && <Banner tone="error" role="alert">{errorMessage}</Banner>}

            {createdCredentials && (
              <CredentialsCard
                credentials={createdCredentials}
                copied={credentialsCopied}
                onCopy={() => { void handleCopyCredentials(); }}
                onDismiss={() => setCreatedCredentials(null)}
              />
            )}

            <section className={CARD_CLASS}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Bulk create from demo staff list</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                    Prepare accounts from the {INITIAL_USERS.length} records in INITIAL_USERS. Existing emails are skipped.
                    Adviser accounts receive randomized, non-duplicate sections from the latest school year.
                  </p>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    Staff sign in with their email and temporary password, then change the password on first login.
                  </p>
                  <p className="mt-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
                    This creates real Supabase login accounts when confirmed. Verify the demo names and email addresses are authorized before continuing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={prepareBulkCreate}
                  disabled={isLoading || Boolean(bulkProgress)}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <Shuffle className="h-4 w-4" />
                  {bulkPlan ? 'Randomize again' : 'Prepare batch'}
                </button>
              </div>

              {bulkPlan && (
                <div className="mt-5 space-y-4">
                  <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
                    Ready to create {bulkPlan.accounts.length} account(s); {bulkPlan.skipped} already exist and will be skipped.
                    {bulkPlan.academicYear ? ` Section assignments use ${bulkPlan.academicYear}.` : ''}
                  </p>
                  <div className="max-h-96 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
                    <table className="w-full min-w-[620px] text-left text-sm">
                      <thead className="sticky top-0 bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                        <tr>
                          <th className="p-3">Staff member</th>
                          <th className="p-3">Email</th>
                          <th className="p-3">Role</th>
                          <th className="p-3">Assigned sections</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {bulkPlan.accounts.map((account) => (
                          <tr key={account.email}>
                            <td className="p-3 font-semibold">{account.name}</td>
                            <td className="p-3">{account.email}</td>
                            <td className="p-3">{getRoleLabel(account.role)}</td>
                            <td className="p-3">{account.assignedSections.join(', ') || 'No section restriction'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBulkConfirmOpen(true)}
                    disabled={Boolean(bulkProgress)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#0f2444] px-4 py-3 font-bold text-white hover:bg-[#1b365d] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <UserPlus className="h-4 w-4" />
                    Create {bulkPlan.accounts.length} account(s)
                  </button>
                </div>
              )}

              {bulkProgress && (
                <p role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-sm font-semibold text-blue-900 dark:text-blue-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating account {bulkProgress.current} of {bulkProgress.total}. Please keep this page open.
                </p>
              )}

              {bulkResults && (
                <div className="mt-5 space-y-4" aria-live="polite">
                  <p className={`rounded-lg border p-3 text-sm font-semibold ${
                    bulkResults.failed.length
                      ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
                      : 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
                  }`}>
                    Created {bulkResults.created.length}; failed {bulkResults.failed.length}; skipped existing {bulkResults.skipped}.
                    Temporary passwords are only held in this page until it is closed or refreshed.
                  </p>
                  {bulkResults.created.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={downloadBulkCredentials}
                        className="inline-flex items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700"
                      >
                        <Download className="h-4 w-4" />
                        Download temporary credentials (CSV)
                      </button>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        The CSV contains passwords in plain text. Download it only to a secure device and share each credential privately.
                      </p>
                    </>
                  )}
                  {bulkResults.failed.length > 0 && (
                    <ul className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
                      {bulkResults.failed.map((account) => (
                        <li key={account.email}><strong>{account.email}:</strong> {account.error}</li>
                      ))}
                    </ul>
                  )}
                  {bulkResults.created.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                      <table className="w-full min-w-[520px] text-left text-sm">
                        <thead className="bg-slate-100 dark:bg-slate-800">
                          <tr>
                            <th className="p-3">Name</th>
                            <th className="p-3">Email</th>
                            <th className="p-3">Temporary password</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 font-mono dark:divide-slate-800">
                          {bulkResults.created.map((account) => (
                            <tr key={account.email}>
                              <td className="p-3 font-sans">{account.name}</td>
                              <td className="p-3">{account.email}</td>
                              <td className="p-3 font-bold">{account.password}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Create account */}
            <section className={CARD_CLASS}>
              <div className="mb-5 flex items-center gap-3">
                <UserPlus className="h-5 w-5 text-blue-800 dark:text-blue-300" />
                <div>
                  <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Create a staff account</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Set a temporary password (or generate one). The staff member can sign in with their username or
                    email and must change the password on first login.
                  </p>
                </div>
              </div>

              <form onSubmit={handleCreate} className="grid gap-4 md:grid-cols-2" noValidate>
                <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  Staff name
                  <input
                    required
                    maxLength={200}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  Staff email
                  <input
                    required
                    type="email"
                    maxLength={320}
                    autoComplete="off"
                    value={email}
                    onChange={(event) => handleEmailChange(event.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  Username
                  <input
                    required
                    maxLength={30}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(event) => handleUsernameChange(event.target.value)}
                    className={INPUT_CLASS}
                  />
                  <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
                    3–30 characters: lowercase letters, numbers, dots, underscores. Suggested from the email.
                  </span>
                </label>

                <label className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  Position
                  <select
                    value={role}
                    onChange={(event) => handleRoleChange(event.target.value)}
                    className={INPUT_CLASS}
                  >
                    {STAFF_ROLES.map((staffRole) => (
                      <option key={staffRole.value} value={staffRole.value}>{staffRole.label}</option>
                    ))}
                  </select>
                </label>
                <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  <label htmlFor="temporary-password">Temporary password</label>
                  <div className="mt-1.5 flex gap-2">
                    <div className="relative min-w-0 flex-1">
                      <input
                        id="temporary-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white py-2.5 pl-3 pr-10 font-mono text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:focus:ring-blue-950"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-2 top-2.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleGeneratePassword}
                      className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-bold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <RefreshCw className="h-4 w-4" />Generate
                    </button>
                  </div>
                  <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
                    At least {MIN_PASSWORD_LENGTH} characters with uppercase, lowercase, and a number.
                  </span>
                </div>

                <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  <label htmlFor="confirm-password">Confirm password</label>
                  <input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    aria-invalid={confirmPassword.length > 0 && password !== confirmPassword}
                    className={`${INPUT_CLASS} font-mono`}
                  />
                  {confirmPassword.length > 0 && (
                    password === confirmPassword ? (
                      <span className="mt-1 block text-xs font-semibold text-emerald-700 dark:text-emerald-400">Passwords match.</span>
                    ) : (
                      <span role="alert" className="mt-1 block text-xs font-semibold text-rose-700 dark:text-rose-400">Passwords do not match.</span>
                    )
                  )}
                </div>


                <fieldset className="min-w-0 md:col-span-2">
                  <legend className="text-sm font-bold text-slate-700 dark:text-slate-200">
                    Assigned sections{needsSections ? ' (required)' : ' (optional)'}
                  </legend>
                  <div className="mt-1.5 overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700">
                    <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                      <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                        {sectionIds.length} selected
                      </span>
                      <button
                        type="button"
                        onClick={toggleAllVisibleSections}
                        disabled={!filteredSections.length}
                        className="text-xs font-bold text-blue-800 hover:underline disabled:opacity-50 dark:text-blue-300"
                      >
                        {allVisibleSelected ? 'Clear shown' : 'Select shown'}
                      </button>
                    </div>
                    <div className="border-b border-slate-200 p-2 dark:border-slate-700">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                        <input
                          type="search"
                          value={sectionSearch}
                          onChange={(event) => setSectionSearch(event.target.value)}
                          placeholder="Search grade or section..."
                          aria-label="Search sections"
                          className="w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm font-normal text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:focus:ring-blue-950"
                        />
                      </div>
                    </div>
                    <div className="max-h-44 overflow-y-auto p-2">
                      {filteredSections.length ? filteredSections.map((section) => {
                        const id = String(section.id);
                        return (
                          <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800">
                            <input
                              type="checkbox"
                              checked={sectionIds.includes(id)}
                              onChange={(event) => toggleSection(id, event.target.checked)}
                              className="h-4 w-4 rounded border-slate-300 text-blue-800 focus:ring-blue-600"
                            />
                            <span>{getSectionLabel(section)}</span>
                          </label>
                        );
                      }) : (
                        <p className="px-2 py-4 text-center text-xs font-normal text-slate-500">No matching sections found.</p>
                      )}
                    </div>
                  </div>
                </fieldset>

                <button
                  type="submit"
                  disabled={isSaving || isLoading || Boolean(bulkProgress)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#0f2444] px-4 py-3 font-bold text-white hover:bg-[#1b365d] disabled:cursor-not-allowed disabled:opacity-60 md:col-span-2"
                >
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isSaving ? 'Creating account…' : 'Create account'}
                </button>
              </form>
            </section>

            {/* Staff directory */}
            <section className={CARD_CLASS}>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Staff directory</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Search staff by name, username, email, position, or assigned section.
                  </p>
                </div>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1 sm:w-72">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input
                      type="search"
                      value={staffSearch}
                      onChange={(event) => setStaffSearch(event.target.value)}
                      placeholder="Search staff..."
                      aria-label="Search staff accounts"
                      className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:focus:ring-blue-950"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setErrorMessage(''); void loadDirectory(); }}
                    disabled={isLoading}
                    aria-label="Refresh staff directory"
                    title="Refresh staff directory"
                    className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-base font-extrabold text-slate-900 dark:text-white">Active staff</h3>
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                  {activeStaff.length}
                </span>
              </div>
              {isLoading ? (
                <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />Loading staff…
                </p>
              ) : (
                <StaffList
                  accounts={filteredActiveStaff}
                  inactive={false}
                  isSearching={Boolean(normalizedStaffSearch)}
                  deactivatingId={deactivatingId}
                  onDeactivate={setPendingDeactivation}
                />
              )}
            </section>

            {/* Inactive staff */}
            <section className={CARD_CLASS}>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-extrabold text-slate-900 dark:text-white">Inactive staff</h2>
                <span className="rounded-full bg-slate-200 px-3 py-1 text-sm font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {inactiveStaff.length}
                </span>
              </div>
              {isLoading ? (
                <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />Loading staff…
                </p>
              ) : (
                <StaffList
                  accounts={filteredInactiveStaff}
                  inactive
                  isSearching={Boolean(normalizedStaffSearch)}
                  deactivatingId={deactivatingId}
                  onDeactivate={setPendingDeactivation}
                />
              )}
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
      <ConfirmDialog
        isOpen={bulkConfirmOpen}
        onClose={() => setBulkConfirmOpen(false)}
        onConfirm={() => { void handleBulkCreate(); }}
        title="Create Supabase staff accounts?"
        message={`This will create ${bulkPlan?.accounts.length || 0} real login account(s) from INITIAL_USERS, each with a temporary password. These seed identities may use synthetic email addresses, so continue only if they are authorized. Adviser sections will be randomized. You can securely download the generated credentials after creation.`}
        confirmLabel="Create staff accounts"
        cancelLabel="Review again"
      />
    </main>
  );
}
