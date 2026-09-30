'use client';
// "I lost something" (§5.2 step 5; §12.4): category, description 3..200, optional pin, optional date.
// The report is bound to this browser's device cookie; there is no email and no recovery path (F-66).
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import type { Category } from '@recover/shared/dto.ts';
import { hasContactInfo } from '@recover/shared/unicode.ts';
import type { PublicMeta } from '@/lib/storage-url.ts';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconCheck } from '@/components/ui/icons.tsx';
import { MapPicker } from '@/components/ui/map-picker.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { Select } from '@/components/ui/select.tsx';
import { TextArea } from '@/components/ui/text-area.tsx';
import type { MapPin } from './MapPicker.tsx';
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

  return (
    <form className="stack-lg" onSubmit={onSubmit} noValidate>
      <Notice title="Saved on this browser only">This report is saved to this browser only. If you clear your browser data you can file it again.</Notice>

      <Select
        id="lost-category"
        label="What did you lose?"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        required
        aria-invalid={invalid('category')}
        aria-describedby={error?.field === 'category' ? 'lost-error' : undefined}
        placeholder="Choose one"
        options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
      />

      <TextArea
        id="lost-desc"
        label="Describe it"
        privateNote="Only you and staff see this"
        hint="It is used to find matches."
        maxLength={200}
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Black North Face backpack with a green keychain"
        required
        aria-invalid={invalid('description')}
        aria-describedby={error?.field === 'description' ? 'lost-error' : undefined}
      />
      {hasContactInfo(description) && <Notice tone="warning">{CONTACT_INFO_MESSAGE}</Notice>}

      {meta.map && (
        <fieldset className="fieldset">
          <legend>
            Where do you think you lost it? <span className="label-optional">(optional)</span>
          </legend>
          <MapPicker
            src={meta.map.url}
            width={meta.map.width}
            height={meta.map.height}
            value={pin}
            onChange={(p) => setPin(p)}
            zones={meta.zones}
            label="Campus map"
            clearable
          />
        </fieldset>
      )}

      <TextInput
        id="lost-on"
        type="date"
        label="When did you lose it?"
        optional
        max={today}
        value={lostOn}
        onChange={(e) => setLostOn(e.target.value)}
        aria-invalid={invalid('lostOn')}
        aria-describedby={error?.field === 'lostOn' ? 'lost-error' : undefined}
      />

      {error && (
        <Notice id="lost-error" tone="danger" live="assertive">
          {error.message}
        </Notice>
      )}
      <Button type="submit" variant="primary" size="lg" loading={busy} loadingText="Saving..." icon={<IconCheck />}>
        Save my report
      </Button>
    </form>
  );
}
