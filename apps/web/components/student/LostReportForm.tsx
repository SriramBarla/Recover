'use client';
// "I lost something" (§5.2 step 5; §12.4): category, description 3..200, optional pin, optional date.
// The report is bound to this browser's device cookie; there is no email and no recovery path (F-66).
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import type { Category } from '@recover/shared/dto.ts';
import { hasContactInfo } from '@recover/shared/unicode.ts';
import type { PublicMeta } from '@/lib/storage-url.ts';
import { MapPicker, type MapPin } from './MapPicker.tsx';
import { apiFetch, needsNewKey, newKey, retryHint, withRetry } from './client-api.ts';
import { CATEGORY_LABELS, CONTACT_INFO_MESSAGE } from './format.ts';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];
type Field = 'category' | 'description' | 'lostOn' | 'pin';

export function LostReportForm({ meta, today }: { meta: PublicMeta; today: string }) {
  const router = useRouter();
  const code = meta.school.code;
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [pin, setPin] = useState<MapPin | null>(null);
  const [lostOn, setLostOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: Field } | null>(null);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!category) return setError({ message: 'Choose what you lost.', field: 'category' });
    if (description.trim().length < 3) return setError({ message: 'Describe it in at least 3 characters.', field: 'description' });
    const body = {
      category,
      description: description.trim(),
      pin,
      mapVersionId: pin && meta.map ? meta.map.versionId : null,
      lostOn: lostOn || null,
    };
    const fingerprint = JSON.stringify(body);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newKey() };
    const a = attempt.current;
    setBusy(true);
    setError(null);
    const r = await withRetry(() => apiFetch(`/api/s/${code}/lost-reports`, { method: 'POST', body, idempotencyKey: a.key }));
    if (r.ok) {
      attempt.current = null;
      router.push(`/s/${code}/lost/mine`);
      router.refresh();
      return;
    }
    setBusy(false);
    if (needsNewKey(r.error)) a.key = newKey();
    const f = r.error.field;
    const field: Field | undefined =
      f === 'category' || f === 'description' || f === 'lostOn'
        ? f
        : f === 'lost_on'
          ? 'lostOn'
          : f === 'pin' || f === 'mapVersionId' || f === 'map_version_id'
            ? 'pin'
            : undefined;
    const contact = r.error.code === 'invalid_input' && field === 'description' && hasContactInfo(description);
    setError({ message: contact ? CONTACT_INFO_MESSAGE : `${r.error.message}${retryHint(r.error)}`, field });
  }

  const invalid = (f: Field) => (error?.field === f ? true : undefined);
  const describedBy = (f: Field, hint: string) => (error?.field === f ? `${hint} lost-error` : hint);

  return (
    <form className="stack-lg" onSubmit={onSubmit} noValidate>
      <p className="notice">This report is saved to this browser only. If you clear your browser data you can file it again.</p>

      <div className="field">
        <label className="label" htmlFor="lost-category">
          What did you lose?
        </label>
        <select
          id="lost-category"
          className="select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          required
          aria-invalid={invalid('category')}
          aria-describedby={error?.field === 'category' ? 'lost-error' : undefined}
        >
          <option value="">Choose one</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="label" htmlFor="lost-desc">
          Describe it
        </label>
        <textarea
          id="lost-desc"
          className="textarea"
          maxLength={200}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Black North Face backpack with a green keychain"
          required
          aria-invalid={invalid('description')}
          aria-describedby={describedBy('description', 'lost-desc-hint lost-desc-count')}
        />
        <p id="lost-desc-hint" className="hint">
          Only you and school staff see this. It is used to find matches.
        </p>
        <p id="lost-desc-count" className="hint">
          {description.length} of 200 characters
        </p>
        {hasContactInfo(description) && <p className="notice notice-warn">{CONTACT_INFO_MESSAGE}</p>}
      </div>

      {meta.map && (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Where do you think you lost it? (optional)</legend>
          <MapPicker map={meta.map} zones={meta.zones} value={pin} onChange={setPin} label="Campus map" />
        </fieldset>
      )}

      <div className="field">
        <label className="label" htmlFor="lost-on">
          When did you lose it? (optional)
        </label>
        <input
          id="lost-on"
          type="date"
          className="input"
          max={today}
          value={lostOn}
          onChange={(e) => setLostOn(e.target.value)}
          aria-invalid={invalid('lostOn')}
          aria-describedby={error?.field === 'lostOn' ? 'lost-error' : undefined}
        />
      </div>

      {error && (
        <p id="lost-error" className="notice notice-danger" role="alert">
          {error.message}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
        {busy ? 'Saving...' : 'Save my report'}
      </button>
    </form>
  );
}
