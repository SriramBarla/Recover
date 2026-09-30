'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconCalendar, IconUpload } from '@/components/ui/icons.tsx';
import { LiveRegion } from '@/components/ui/live-region.tsx';
import { Notice } from '@/components/ui/notice.tsx';
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
  const coverage = horizonDays === null ? 'Calendar coverage is not reported yet.' : `Covered for the next ${horizonDays} days${lastDay ? ` (through ${lastDay})` : ''}.`;

  return (
    <section className="card card-pad-lg stack" aria-labelledby="calendar-h">
      <h2 id="calendar-h" className="with-icon">
        <IconCalendar />
        School calendar
      </h2>
      {warn ? (
        <Notice tone="warning">
          <p>
            {coverage} Upload more days: drop-off deadlines stop being computed when coverage runs out.
          </p>
        </Notice>
      ) : (
        <p className="muted">{coverage}</p>
      )}
      <TextInput
        id="calendar-file"
        label="CSV file with columns day,is_open,open_at,close_at"
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => void onFile(e.target.files?.[0])}
        hint={
          <>
            Example lines: <code className="nowrap">2026-10-01,true,07:45,15:30</code> and <code className="nowrap">2026-10-03,false,,</code>
          </>
        }
      />
      {errors.length > 0 ? (
        <Notice tone="danger" live="assertive" title="Fix these lines and choose the file again:">
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {rows.length > 0 && errors.length === 0 ? (
        <div className="stack">
          <p>
            {rows.length} days from {s.first} to {s.last}: {s.open} open, {s.closed} closed. Existing days in this range are replaced.
          </p>
          <div>
            <Button variant="primary" disabled={busy} onClick={() => void upload()} icon={<IconUpload />}>
              {busy ? 'Uploading...' : 'Upload calendar'}
            </Button>
          </div>
        </div>
      ) : null}
      <LiveRegion message={done} />
      {done ? <Notice tone="success">{done}</Notice> : null}
      <ActionError error={error} />
    </section>
  );
}
