'use client';
// "Found something" (§5.1; 04 screen inventory): category -> photos -> where -> describe -> send -> done.
// High-value categories end at "take it to the office now" with no photo and no draft. Sending creates the
// draft (Idempotency-Key kept for retries), PUTs each JPEG to its presigned URL with 3 retries and
// backoff, then completes. A failed send resumes: the same key replays the same draft with fresh upload
// URLs, and only photos that did not upload are sent again.
import { useEffect, useRef, useState } from 'react';
import { HIGH_VALUE_CATEGORIES, STUDENT_CATEGORIES, type Category, type Completed, type UploadSpec } from '@recover/shared/dto.ts';
import { hasContactInfo } from '@recover/shared/unicode.ts';
import type { PublicMeta } from '@/lib/storage-url.ts';
import { Button, LinkButton } from '@/components/ui/button.tsx';
import { CATEGORY_HINT, CategoryIcon } from '@/components/ui/category.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconArrowLeft, IconArrowRight, IconBuilding, IconCheck, IconHome, IconRefresh, IconTag } from '@/components/ui/icons.tsx';
import { MapPicker } from '@/components/ui/map-picker.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { Select } from '@/components/ui/select.tsx';
import { Stepper } from '@/components/ui/stepper.tsx';
import { TextArea } from '@/components/ui/text-area.tsx';
import { TileButton } from '@/components/ui/tile.tsx';
import { nearestById, type MapPin } from './MapPicker.tsx';
import { PhotoSlots } from './PhotoSlots.tsx';
import { apiFetch, needsNewKey, newKey, reportClientError, retryHint, withRetry, type ApiError } from './client-api.ts';
import { CATEGORY_LABELS, CONTACT_INFO_MESSAGE, categoryLabel, formatDateTime } from './format.ts';
import type { Photo } from './photo.ts';

type Step = 'category' | 'highvalue' | 'photos' | 'where' | 'describe' | 'submit' | 'done';

const PROGRESS: { step: Step; label: string }[] = [
  { step: 'category', label: 'What it is' },
  { step: 'photos', label: 'Photos' },
  { step: 'where', label: 'Where' },
  { step: 'describe', label: 'Describe' },
  { step: 'submit', label: 'Send' },
];

const TITLES: Record<Step, string> = {
  category: 'What did you find?',
  highvalue: 'Take it to the office now',
  photos: 'Take photos',
  where: 'Where did you find it?',
  describe: 'Describe it',
  submit: 'Sending your post',
  done: 'Thank you!',
};

// Server validation fields (invalid_input detail) mapped back to the step that owns them. The route names
// fields in camelCase; the SQL functions' own checks use snake_case.
const FIELD_STEP: Record<string, Step> = {
  category: 'category',
  photoCount: 'photos',
  photo_count: 'photos',
  pin: 'where',
  mapVersionId: 'where',
  map_version_id: 'where',
  note: 'where',
  dropoffLocationId: 'where',
  dropoff_location_id: 'where',
  description: 'describe',
};

type Attempt = { fingerprint: string; createKey: string; completeKey: string; itemId: string | null; uploaded: Set<number> };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One PUT with 3 retries (1 s, 2 s, 4 s). A 4xx other than 408/429 means the capability itself was
// refused (expired or wrong), so only a fresh URL from a replayed create can help.
async function putWithRetry(url: string, blob: Blob): Promise<boolean> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return false;
    } catch {
      // network failure: retry
    }
  }
  return false;
}

function Progress({ step }: { step: Step }) {
  const index = PROGRESS.findIndex((p) => p.step === step);
  return <Stepper steps={PROGRESS.map((p) => p.label)} current={index + 1} />;
}

function StepNav({ onBack, onNext, nextLabel = 'Next', disabled = false }: { onBack?: () => void; onNext: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <div className="wizard-nav">
      {onBack ? (
        <Button onClick={onBack} disabled={disabled} icon={<IconArrowLeft />}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button variant="primary" size="lg" onClick={onNext} disabled={disabled} iconEnd={<IconArrowRight />}>
        {nextLabel}
      </Button>
    </div>
  );
}

export function FoundWizard({ meta, src }: { meta: PublicMeta; src: string | null }) {
  const code = meta.school.code;
  const locations = meta.locations;
  const office = locations[0] ?? null;
  const enabled = STUDENT_CATEGORIES.filter((c) => meta.school.enabledCategories.includes(c));
  const studentCategories = enabled.length > 0 ? enabled : [...STUDENT_CATEGORIES];

  const [step, setStep] = useState<Step>('category');
  const [category, setCategory] = useState<Category | null>(null);
  const [photos, setPhotos] = useState<(Photo | null)[]>([null, null, null]);
  const [photosVersion, setPhotosVersion] = useState(0);
  const [pin, setPin] = useState<MapPin | null>(null);
  const [note, setNote] = useState('');
  const [dropoffId, setDropoffId] = useState(office?.id ?? '');
  const [dropoffChosen, setDropoffChosen] = useState(false);
  const [description, setDescription] = useState('');
  const [stepError, setStepError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState('');
  const [failure, setFailure] = useState<{ message: string; retry: boolean } | null>(null);
  const [result, setResult] = useState<Completed | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const photosRef = useRef(photos);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(
    () => () => {
      for (const p of photosRef.current) if (p) URL.revokeObjectURL(p.url);
    },
    [],
  );
  // Move focus to the new step's heading so screen readers announce it (not on first load).
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const dropoff = locations.find((l) => l.id === dropoffId) ?? office;

  function go(next: Step) {
    setStepError(null);
    setStep(next);
  }

  function chooseCategory(c: Category) {
    setCategory(c);
    if (HIGH_VALUE_CATEGORIES.includes(c)) {
      go('highvalue');
      void apiFetch(`/api/s/${code}/events/high-value`, { method: 'POST', body: { category: c } }); // count only
      return;
    }
    go('photos');
  }

  function onPhotos(next: (Photo | null)[]) {
    setPhotos(next);
    setPhotosVersion((v) => v + 1);
  }

  function onPin(p: MapPin | null) {
    setPin(p);
    if (p && !dropoffChosen && meta.map) {
      const near = nearestById(p, locations, meta.map.width, meta.map.height);
      if (near) setDropoffId(near.id);
    }
  }

  function stop(e: ApiError) {
    setWorking(false);
    setProgress('');
    const owner = e.code === 'invalid_input' && e.field ? FIELD_STEP[e.field] : undefined;
    if (owner) {
      // The server rejects contact details at submit (§10.2); say so instead of the generic field message.
      const contact = (e.field === 'description' && hasContactInfo(description)) || (e.field === 'note' && hasContactInfo(note));
      setStepError(contact ? CONTACT_INFO_MESSAGE : e.message);
      setStep(owner);
      return;
    }
    const final = e.code === 'device_blocked' || e.code === 'feature_disabled' || (e.code === 'rate_limited' && (e.retryAfterS ?? 0) > 60);
    setFailure({ message: `${e.message}${retryHint(e)}`, retry: !final });
  }

  async function submit() {
    const list = photos.filter((p): p is Photo => p !== null);
    if (!category || list.length === 0) return;
    const body = {
      category,
      description: description.trim(),
      note: note.trim() || null,
      pin,
      mapVersionId: pin && meta.map ? meta.map.versionId : null,
      dropoffLocationId: dropoffId,
      photoCount: list.length,
      src,
    };
    const fingerprint = `${JSON.stringify(body)}|${photosVersion}`;
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, createKey: newKey(), completeKey: newKey(), itemId: null, uploaded: new Set() };
    }
    const a = attempt.current;
    setStep('submit');
    setStepError(null);
    setFailure(null);
    setWorking(true);

    setProgress('Saving your post.');
    const created = await withRetry(() =>
      apiFetch<{ itemId: string; uploads: UploadSpec[] }>(`/api/s/${code}/items`, { method: 'POST', body, idempotencyKey: a.createKey }),
    );
    if (!created.ok) {
      if (needsNewKey(created.error, { draftStoredBeforeUpstream: true })) a.createKey = newKey();
      return stop(created.error);
    }
    if (a.itemId !== created.data.itemId) {
      a.itemId = created.data.itemId;
      a.uploaded = new Set();
    }

    const total = list.length;
    let sent = a.uploaded.size;
    setProgress(`Uploading photos: ${sent} of ${total} done.`);
    const results = await Promise.all(
      list.map(async (photo, position) => {
        if (a.uploaded.has(position)) return true;
        const target = created.data.uploads.find((u) => u.position === position);
        if (!target || !(await putWithRetry(target.url, photo.blob))) return false;
        a.uploaded.add(position);
        sent += 1;
        setProgress(`Uploading photos: ${sent} of ${total} done.`);
        return true;
      }),
    );
    if (results.includes(false)) {
      reportClientError('upload_failed');
      return stop({ code: 'upload', message: 'Your photos did not finish uploading. Check your connection and try again.', status: 0 });
    }

    setProgress('Finishing up.');
    const completed = await withRetry(() =>
      apiFetch<Completed>(`/api/s/${code}/items/${a.itemId}/complete`, { method: 'POST', body: {}, idempotencyKey: a.completeKey }),
    );
    if (!completed.ok) {
      // api_complete_item is idempotent on its own, so a fresh key after any failure is harmless and keeps a
      // stored 4xx from replaying on every retry.
      a.completeKey = newKey();
      return stop(completed.error);
    }

    attempt.current = null;
    setWorking(false);
    setProgress('');
    setResult(completed.data);
    for (const p of photos) if (p) URL.revokeObjectURL(p.url);
    setPhotos([null, null, null]);
    go('done');
  }

  const deadline = result?.arrivalDeadlineAt ? formatDateTime(result.arrivalDeadlineAt, meta.school.timezone) : '';

  return (
    <div className="stack-lg container-narrow" style={{ padding: 0 }}>
      <h1>Report a found item</h1>
      {step !== 'highvalue' && step !== 'done' && <Progress step={step} />}
      <section aria-labelledby="found-step" className="stack">
        <h2 id="found-step" ref={headingRef} tabIndex={-1}>
          {step === 'highvalue' && office ? `Take it to ${office.name} now` : TITLES[step]}
        </h2>
        {stepError && step !== 'describe' && (
          <Notice tone="danger" live="assertive">
            {stepError}
          </Notice>
        )}

        {step === 'category' && (
          <div className="stack-lg">
            <ul className="tile-grid" aria-label="What it is">
              {studentCategories.map((c) => (
                <li key={c}>
                  <TileButton
                    icon={<CategoryIcon category={c} />}
                    label={CATEGORY_LABELS[c]}
                    description={c === 'electronics_low' ? undefined : CATEGORY_HINT[c]}
                    onClick={() => chooseCategory(c)}
                  />
                </li>
              ))}
            </ul>
            <div className="stack-sm">
              <h3 className="with-icon">
                <IconBuilding />
                These go straight to the office
              </h3>
              <ul className="tile-grid" aria-label="Items that go straight to the office">
                {HIGH_VALUE_CATEGORIES.map((c) => (
                  <li key={c}>
                    <TileButton accent icon={<CategoryIcon category={c} />} label={CATEGORY_LABELS[c]} onClick={() => chooseCategory(c)} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {step === 'highvalue' && (
          <div className="stack">
            <Notice tone="warning" title="No photo needed">
              Phones, wallets, keys, ID cards and medication go straight to the office. Please do not take photos of them.
            </Notice>
            {office ? (
              <div className="card">
                <p className="with-icon" style={{ margin: 0 }}>
                  <IconBuilding />
                  <strong>{office.name}</strong>
                </p>
                {office.hours ? <p className="muted" style={{ margin: '0.25rem 0 0' }}>{office.hours}</p> : null}
              </div>
            ) : (
              <p>Take it to the front office.</p>
            )}
            {locations.length > 1 && (
              <>
                <p>You can also take it to:</p>
                <ul>
                  {locations.slice(1).map((l) => (
                    <li key={l.id}>
                      {l.name}
                      {l.hours ? ` (${l.hours})` : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="wizard-nav">
              <Button onClick={() => go('category')} icon={<IconArrowLeft />}>
                Back
              </Button>
              <LinkButton variant="primary" size="lg" href={`/s/${code}`} prefetch={false} icon={<IconCheck />}>
                Done
              </LinkButton>
            </div>
          </div>
        )}

        {step === 'photos' && (
          <div className="stack">
            <PhotoSlots photos={photos} onChange={onPhotos} itemLabel={categoryLabel(category)} />
            <p className="hint">If your camera does not open, take the item to the front office instead.</p>
            <StepNav
              onBack={() => go('category')}
              onNext={() => (photos.some((p) => p !== null) ? go('where') : setStepError('Add at least one photo.'))}
            />
          </div>
        )}

        {step === 'where' && (
          <div className="stack-lg">
            {meta.map ? (
              <MapPicker
                src={meta.map.url}
                width={meta.map.width}
                height={meta.map.height}
                value={pin}
                onChange={(p) => onPin(p)}
                zones={meta.zones}
                label="Campus map"
                clearable
                priority
              />
            ) : (
              <Notice>This school does not have a map yet. Use the box below to say where you found it.</Notice>
            )}
            <TextInput
              id="found-note"
              label="Room or exact spot"
              optional
              privateNote="Only staff see this"
              hint="For example C214, or under the gym bleachers. It is never posted."
              maxLength={80}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoComplete="off"
            />
            {hasContactInfo(note) && <Notice tone="warning">{CONTACT_INFO_MESSAGE}</Notice>}
            {locations.length > 0 ? (
              <Select
                id="found-dropoff"
                label="Where will you take it?"
                hint={dropoff?.hours ? `Hours: ${dropoff.hours}` : 'Check the hours at the office.'}
                value={dropoffId}
                onChange={(e) => {
                  setDropoffId(e.target.value);
                  setDropoffChosen(true);
                }}
                options={locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            ) : (
              <Notice tone="warning">This school has no drop-off locations set up yet. Please take the item to the front office.</Notice>
            )}
            <StepNav onBack={() => go('photos')} onNext={() => go('describe')} disabled={locations.length === 0} />
          </div>
        )}

        {step === 'describe' && (
          <div className="stack">
            <TextArea
              id="found-desc"
              label="Short description"
              hint="Everyone can see this. Describe the item, not the owner."
              maxLength={120}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="navy metal water bottle"
              error={stepError ?? undefined}
              autoComplete="off"
            />
            {hasContactInfo(description) && <Notice tone="warning">{CONTACT_INFO_MESSAGE}</Notice>}
            <StepNav
              onBack={() => go('where')}
              nextLabel="Post it"
              onNext={() => {
                if (description.trim().length < 2) setStepError('Describe the item in at least 2 characters.');
                else void submit();
              }}
            />
          </div>
        )}

        {step === 'submit' && (
          <div className="stack">
            <p role="status" className="with-icon">
              {working ? <span className="spinner" aria-hidden="true" /> : null}
              {progress}
            </p>
            {working && <p className="hint">Keep this page open until it finishes.</p>}
            {failure && (
              <Notice
                tone="danger"
                live="assertive"
                title="Your post did not finish"
                actions={
                  failure.retry ? (
                    <>
                      <Button variant="primary" onClick={() => void submit()} icon={<IconRefresh />}>
                        Try again
                      </Button>
                      <Button onClick={() => go('describe')} icon={<IconArrowLeft />}>
                        Go back
                      </Button>
                    </>
                  ) : undefined
                }
              >
                <p>{failure.message}</p>
                <p className="small">You can also take the item to {office?.name ?? 'the front office'} and staff will post it.</p>
              </Notice>
            )}
          </div>
        )}

        {step === 'done' && result && (
          <div className="stack">
            <Notice tone="success" title={`Bring it to ${dropoff?.name ?? 'the front office'} by the end of the next school day${deadline ? ` (${deadline})` : ''}.`}>
              {dropoff?.hours && <p>Hours: {dropoff.hours}</p>}
            </Notice>
            <div className="id-callout">
              <p className="id-callout-label">Item ID</p>
              <p className="id-callout-value mono">{result.publicId}</p>
              <p className="small muted">Tell the office this ID when you drop it off.</p>
            </div>
            <p>It shows up in the found items after staff check it.</p>
            <div className="button-row">
              <LinkButton variant="primary" href={`/s/${code}/mine`} prefetch={false} icon={<IconTag />}>
                See your posts
              </LinkButton>
              <LinkButton href={`/s/${code}`} prefetch={false} icon={<IconHome />}>
                Back to found items
              </LinkButton>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
