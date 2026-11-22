import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Loader2, UploadCloud } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { parseRosterWorkbook } from '../utils/etlImport';

const getImportErrorMessage = async (error) => {
  if (error?.context && typeof error.context.json === 'function') {
    try {
      const body = await error.context.json();
      if (typeof body?.error === 'string') return body.error;
    } catch {
      return error.message || 'The roster import request failed.';
    }
  }
  return error?.message || 'The roster import request failed.';
};

export default function EtlManagementPage() {
  const { isSuperAdmin } = useAuth();
  const [etlRuns, setEtlRuns] = useState([]);
  const [rejectedRecords, setRejectedRecords] = useState([]);
  const [currentStudents, setCurrentStudents] = useState([]);
  const [rosterError, setRosterError] = useState('');
  const [activeTab, setActiveTab] = useState('runs');
  const [isReadingWorkbook, setIsReadingWorkbook] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [selectedFileName, setSelectedFileName] = useState('');
  const [historyError, setHistoryError] = useState('');
  const fileInputRef = useRef(null);

  const fetchEtlData = async () => {
    const [runsResult, rejectedResult] = await Promise.all([
      supabase.from('etl_runs').select('*').order('id', { ascending: false }).limit(20),
      supabase
        .from('etl_rejected_records')
        .select('*, etl_runs(batch_id, source_file)')
        .order('id', { ascending: false })
        .limit(30),
    ]);

    const errors = [];
    if (runsResult.error) errors.push(`Import history: ${runsResult.error.message}`);
    else setEtlRuns(runsResult.data || []);
    if (rejectedResult.error) errors.push(`Rejected rows: ${rejectedResult.error.message}`);
    else setRejectedRecords(rejectedResult.data || []);
    setHistoryError(errors.length ? `Could not load some import history: ${errors.join(' | ')}` : '');
  };

  const loadCurrentStudents = async () => {
    const { data, error } = await supabase.functions.invoke('append-roster', {
      body: { action: 'list' },
    });
    if (error) {
      setRosterError(`Could not load the active student roster: ${await getImportErrorMessage(error)}`);
      return;
    }
    setCurrentStudents(data.students || []);
    setRosterError('');
  };

  useEffect(() => {
    const load = async () => {
      await Promise.all([fetchEtlData(), loadCurrentStudents()]);
    };
    void load();
  }, []);

  const handleFile = async (file) => {
    if (!isSuperAdmin || !file || isSyncing) return;
    setIsReadingWorkbook(true);
    setSyncFeedback(null);
    try {
      const preview = await parseRosterWorkbook(file);
      setImportPreview(preview);
      setSelectedFileName(file.name);
      setSyncFeedback({
        type: preview.rejected.length ? 'error' : 'info',
        message: preview.rejected.length
          ? 'May invalid na row. Ayusin ang lahat bago mag-upload; hindi magbabago ang roster kung may invalid row.'
          : 'Nabasa ang file. Suriin ang preview bago i-update ang listahan ng kasalukuyang enrolled students.',
      });
    } catch (error) {
      setImportPreview(null);
      setSelectedFileName(file.name);
      setSyncFeedback({ type: 'error', message: error.message || 'Could not read the selected workbook.' });
    } finally {
      setIsReadingWorkbook(false);
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDraggingFile(false);
    if (isReadingWorkbook || isSyncing) return;
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const handleSync = async () => {
    if (!isSuperAdmin || !importPreview || importPreview.rejected.length) return;
    const confirmation = [
      'Gagamitin ba ang file bilang kumpletong listahan ng kasalukuyang enrolled students?',
      `${importPreview.students.length} student record(s) ang nasa file.`,
      'Ang mga wala sa listahan ay mamarkahang inactive; hindi buburahin ang kanilang records o case history.',
      'Student No. (LRN), buong pangalan, section, at kasalukuyang academic year ang ise-save.',
    ].join('\n\n');
    if (!window.confirm(confirmation)) return;

    setIsSyncing(true);
    setSyncFeedback(null);
    try {
      const { data, error } = await supabase.functions.invoke('append-roster', {
        body: {
          sourceFile: selectedFileName,
          students: importPreview.students,
          rejected: importPreview.rejected,
        },
      });
      if (error) throw new Error(await getImportErrorMessage(error));

      if (data?.success) {
        setSyncFeedback({
          type: 'success',
          message: `Student list updated: ${data.students_inserted} added, ${data.students_updated} updated, ${data.students_deactivated} marked inactive. Walang record na binura.`,
        });
        setImportPreview(null);
        window.dispatchEvent(new Event('hayagsync:roster-updated'));
        await Promise.all([fetchEtlData(), loadCurrentStudents()]);
      } else {
        setSyncFeedback({
          type: 'error',
          message: data?.message || `Hindi tinanggap ang file. ${data?.rejected_count || 0} issue(s); walang roster na binago.`,
        });
        await Promise.all([fetchEtlData(), loadCurrentStudents()]);
      }
    } catch (error) {
      setSyncFeedback({
        type: 'error',
        message: error.message || 'Could not complete the roster update. No partial data should be committed.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  if (!isSuperAdmin) {
    return (
      <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
        Student roster management is restricted to Super Admin.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-200 pb-4 dark:border-slate-800">
        <h2 className="flex items-center gap-3 text-2xl font-extrabold text-slate-900 dark:text-white">
          <Database className="h-7 w-7 text-blue-900 dark:text-blue-400" />
          Student Enrollment Roster
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Mag-upload ng kumpletong listahan ng kasalukuyang enrolled students. May database check para sa mobile registration na naghahambing ng Student No., full name, at section; kailangang tawagin ito ng mobile app.
        </p>
      </header>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="font-bold text-slate-900 dark:text-white">Excel format</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Gumamit ng .xlsx file na may <strong>Student No.</strong>, <strong>Student Full Name</strong>, at <strong>Grade Level &amp; Section</strong> columns. Maaari ring pangalanan ang worksheet na “Students”. Panatilihing text ang Student No. para hindi mawala ang leading zero.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Ang section ay dapat existing section name o nasa format na “Grade 7 - Section Name”. Ang current academic year ay kukunin mula sa school settings.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          disabled={isReadingWorkbook || isSyncing}
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isReadingWorkbook || isSyncing}
          onDragEnter={(event) => {
            if (Array.from(event.dataTransfer.types).includes('Files')) setIsDraggingFile(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (isReadingWorkbook || isSyncing) {
              event.dataTransfer.dropEffect = 'none';
              return;
            }
            event.dataTransfer.dropEffect = 'copy';
            if (Array.from(event.dataTransfer.types).includes('Files')) setIsDraggingFile(true);
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
              setIsDraggingFile(false);
            }
          }}
          onDrop={handleDrop}
          className={`flex w-full items-center gap-4 rounded-xl border-2 border-dashed p-5 text-left dark:border-slate-700 dark:bg-slate-950/30 ${
            isDraggingFile
              ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-200 dark:border-blue-400 dark:bg-blue-950/40 dark:ring-blue-900'
              : 'border-slate-300 bg-slate-50 hover:border-blue-500'
          }`}
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
            {isReadingWorkbook ? <Loader2 className="h-6 w-6 animate-spin" /> : <UploadCloud className="h-6 w-6" />}
          </span>
          <span className="min-w-0">
            <span className="block font-bold text-slate-900 dark:text-white">
              {isReadingWorkbook ? 'Binabasa ang workbook…' : 'Pumili ng Excel workbook'}
            </span>
              <span className="block truncate text-sm text-slate-500">
                {isDraggingFile ? 'I-drop ang file dito' : selectedFileName || 'I-drop dito o pumili ng .xlsx hanggang 10 MB'}
              </span>
          </span>
        </button>

        {syncFeedback && (
          <div className={`rounded-lg border p-3 text-sm ${
            syncFeedback.type === 'error'
              ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200'
              : syncFeedback.type === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'
                : 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200'
          }`}>
            {syncFeedback.message}
          </div>
        )}

        {importPreview && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="rounded-lg bg-slate-100 px-3 py-2 dark:bg-slate-800">
                Rows: <strong>{importPreview.totalRows}</strong>
              </span>
              <span className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                Valid students: <strong>{importPreview.students.length}</strong>
              </span>
              <span className="rounded-lg bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                Invalid rows: <strong>{importPreview.rejected.length}</strong>
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800">
                  <tr>
                    <th className="p-2">Student No.</th>
                    <th className="p-2">Student Full Name</th>
                    <th className="p-2">Grade Level &amp; Section</th>
                  </tr>
                </thead>
                <tbody>
                  {importPreview.students.slice(0, 10).map((student) => (
                    <tr key={student.student_no} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="p-2 font-mono">••••{student.student_no.slice(-4)}</td>
                      <td className="p-2">{student.full_name}</td>
                      <td className="p-2">{student.currently_section}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {importPreview.students.length > 10 && (
                <p className="p-2 text-xs text-slate-500">First 10 students shown.</p>
              )}
            </div>

            {importPreview.rejected.length > 0 && (
              <div className="max-h-52 overflow-auto rounded-lg border border-rose-200 dark:border-rose-900">
                <div className="flex items-center gap-2 bg-rose-50 p-3 text-sm font-bold text-rose-900 dark:bg-rose-950/50 dark:text-rose-200">
                  <AlertTriangle className="h-4 w-4" /> Ayusin ang invalid rows bago mag-upload.
                </div>
                {importPreview.rejected.slice(0, 100).map((row) => (
                  <p key={`${row.sheet}-${row.rowNumber}`} className="border-t border-rose-100 p-2 text-xs dark:border-rose-900">
                    Row {row.rowNumber} ({row.identifier}): {row.reason}
                  </p>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => { void handleSync(); }}
              disabled={isSyncing || importPreview.rejected.length > 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-900 px-5 py-2.5 text-sm font-bold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {isSyncing ? 'Ina-update ang student list…' : 'I-update ang enrolled student list'}
            </button>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 p-5 dark:border-slate-800">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-extrabold text-slate-900 dark:text-white">Currently active students</h3>
              <p className="mt-1 text-sm text-slate-500">Ang listahang ito ang roster na gagamitin sa mobile registration match.</p>
            </div>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-bold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              {currentStudents.length}
            </span>
          </div>
        </div>
        {rosterError ? (
          <p role="alert" className="m-5 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">{rosterError}</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                <tr>
                  <th className="p-3">Student No.</th>
                  <th className="p-3">Student Full Name</th>
                  <th className="p-3">Grade Level &amp; Section</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {currentStudents.map((student) => (
                  <tr key={student.id}>
                    <td className="p-3 font-mono">{student.lrn}</td>
                    <td className="p-3">{student.name}</td>
                    <td className="p-3">{student.grade} - {student.section}</td>
                  </tr>
                ))}
                {currentStudents.length === 0 && (
                  <tr><td colSpan={3} className="p-6 text-center text-slate-500">Walang active na enrolled students.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {historyError && (
        <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
          <AlertTriangle className="mr-2 inline h-4 w-4" />{historyError}
        </div>
      )}

      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-800">
        {[
          ['runs', `Import history (${etlRuns.length})`],
          ['rejected', `Rejected rows (${rejectedRecords.length})`],
        ].map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`border-b-2 px-4 py-3 text-sm font-bold ${
              activeTab === tab
                ? 'border-blue-900 text-blue-900 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-slate-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'runs' ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
              <tr>
                <th className="p-3">Date</th>
                <th className="p-3">Source file</th>
                <th className="p-3">Added</th>
                <th className="p-3">Updated</th>
                <th className="p-3">Inactive</th>
                <th className="p-3">Rejected</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {etlRuns.map((run) => (
                <tr key={run.id}>
                  <td className="whitespace-nowrap p-3">{new Date(run.started_at).toLocaleString()}</td>
                  <td className="max-w-xs truncate p-3">{run.source_file || 'Excel workbook'}</td>
                  <td className="p-3">{run.students_inserted}</td>
                  <td className="p-3">{run.students_updated || 0}</td>
                  <td className="p-3">{run.students_deactivated || 0}</td>
                  <td className="p-3">{run.rejected_count}</td>
                  <td className="p-3 font-bold">{run.status}</td>
                </tr>
              ))}
              {etlRuns.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Wala pang import history.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200">
              <tr><th className="p-3">Row</th><th className="p-3">Student No.</th><th className="p-3">Reason</th><th className="p-3">File</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rejectedRecords.map((record) => (
                <tr key={record.id}>
                  <td className="p-3">{record.row_number || '—'}</td>
                  <td className="p-3 font-mono">{record.identifier || '—'}</td>
                  <td className="p-3">{record.reason}</td>
                  <td className="p-3">{record.etl_runs?.source_file || '—'}</td>
                </tr>
              ))}
              {rejectedRecords.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500">Walang rejected rows.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
