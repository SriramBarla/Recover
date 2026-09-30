'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ActionError } from './ActionError.tsx';
import { staffApi } from './client-api.ts';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
];

// Create a school and assign its first school admin (§5.6, §24 step 1). The database validates the
// timezone against pg_timezone_names (F-101).
export function SchoolsManager() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await staffApi('/api/district/schools', {
        body: { code: code.trim().toUpperCase(), name, timezone, adminEmail, adminName: adminName.trim() ? adminName : null },
      });
      setCreated(code.trim().toUpperCase());
      setCode('');
      setName('');
      setAdminEmail('');
      setAdminName('');
      router.refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card stack" aria-labelledby="new-school-h">
      <h2 id="new-school-h">Add a school</h2>
      <div className="grid">
        <label className="field">
          <span className="label">Code</span>
          <input className="input mono" required pattern="[A-Za-z]{2,6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FCHS" />
          <span className="hint">2 to 6 letters; appears in links and item IDs.</span>
        </label>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Timezone</span>
          <input className="input" required list="tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <datalist id="tz-list">
            {TIMEZONES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span className="label">First school admin email</span>
          <input className="input" type="email" required value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Their name (optional)</span>
          <input className="input" maxLength={80} value={adminName} onChange={(e) => setAdminName(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Creating...' : 'Create school'}
      </button>
      <ActionError error={error} />
      {created ? (
        <div className="notice notice-ok" role="status">
          Created {created}. <a href={`/district/schools?school=${created}`}>Open its onboarding checklist</a>.
        </div>
      ) : null}
    </form>
  );
}
