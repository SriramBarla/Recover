'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionError } from './ActionError.tsx';
import { staffApi } from './client-api.ts';
import { parseCalendarCsv, summarize, type CalendarRow } from './calendar-csv.ts';

const CHUNK = 400;

// Operating-calendar CSV upload (`day,is_open,open_at,close_at`). Arrival deadlines count open school
// days from this table, and expiry fails safe without coverage (G-01, F-80); onboarding wants at least
// 90 days ahead (§24 step 1).
export function CalendarUpload({ code, horizonDays, lastDay }: { code: string; horizonDays: number | null; lastDay: string | null }) {
  const router = useRouter();
  const [rows, setRows] = useState<CalendarRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');
  const s = summarize(rows);

  const onFile = async (file: File | undefined) => {
    setDone('');
    setError(null);
    if (!file) {
      setRows([]);
      setErrors([]);
      return;
    }
    if (file.size > 512 * 1024) {
      setRows([]);
      setErrors(['The file is too large for a calendar.']);
      return;
    }
    const parsed = parseCalendarCsv(await file.text());
    setRows(parsed.rows);
    setErrors(parsed.errors);
  };

  const upload = async () => {
    setBusy(true);
    setError(null);
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        await staffApi(`/api/staff/${code}/calendar`, { body: { days: rows.slice(i, i + CHUNK) } });
      }
      setDone(`Uploaded ${rows.length} days.`);
      setRows([]);
      router.refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const warn = horizonDays !== null && horizonDays < 45;

  return (
    <div className="card stack">
      <h2>School calendar</h2>
      <p className={warn ? 'notice notice-warn' : 'muted'} style={{ margin: 0 }}>
        {horizonDays === null ? 'Calendar coverage is not reported yet.' : `Covered for the next ${horizonDays} days${lastDay ? ` (through ${lastDay})` : ''}.`}
        {warn ? ' Upload more days: drop-off deadlines stop being computed when coverage runs out.' : ''}
      </p>
      <label className="field">
        <span className="label">CSV file with columns day,is_open,open_at,close_at</span>
        <input className="input" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        <span className="hint">Example lines: 2026-10-01,true,07:45,15:30 and 2026-10-03,false,,</span>
      </label>
      {errors.length > 0 ? (
        <div className="notice notice-danger" role="alert">
          <p style={{ margin: 0 }}>Fix these lines and choose the file again:</p>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {rows.length > 0 && errors.length === 0 ? (
        <div className="stack">
          <p style={{ margin: 0 }}>
            {rows.length} days from {s.first} to {s.last}: {s.open} open, {s.closed} closed. Existing days in this range are replaced.
          </p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void upload()}>
            {busy ? 'Uploading...' : 'Upload calendar'}
          </button>
        </div>
      ) : null}
      {done ? (
        <div className="notice notice-ok" role="status">
          {done}
        </div>
      ) : null}
      <ActionError error={error} />
    </div>
  );
}
