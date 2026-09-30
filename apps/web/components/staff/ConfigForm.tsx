'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { STUDENT_CATEGORIES } from '@recover/shared/dto.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { staffApi } from './client-api.ts';
import { categoryLabel } from './format.ts';
import type { SchoolConfig } from './shapes.ts';

type Props = { code: string; config: SchoolConfig };

// School configuration (§5.5): feature switches (effective = district switch AND school switch),
// retention between the district floor and ceiling, never-arrived school days, and categories.
// Saving needs a recent sign-in (G-31) and only changed keys are sent.
export function ConfigForm({ code, config }: Props) {
  const router = useRouter();
  const [studentPosting, setStudentPosting] = useState(config.studentPosting);
  const [lostReports, setLostReports] = useState(config.lostReports);
  const [crossSchool, setCrossSchool] = useState(config.crossSchoolSearch);
  const [retention, setRetention] = useState(config.retentionDays ?? 30);
  const [neverArrived, setNeverArrived] = useState(config.neverArrivedSchoolDays ?? 1);
  const [categories, setCategories] = useState<string[]>(config.enabledCategories.length ? config.enabledCategories : [...STUDENT_CATEGORIES]);
  const [saved, setSaved] = useState('');

  const changes: Record<string, unknown> = {};
  if (studentPosting !== config.studentPosting) changes.studentPostingEnabled = studentPosting;
  if (lostReports !== config.lostReports) changes.lostReportsEnabled = lostReports;
  if (crossSchool !== config.crossSchoolSearch) changes.crossSchoolSearchEnabled = crossSchool;
  if (config.retentionDays !== null && retention !== config.retentionDays) changes.retentionDays = retention;
  if (config.neverArrivedSchoolDays !== null && neverArrived !== config.neverArrivedSchoolDays) changes.neverArrivedSchoolDays = neverArrived;
  const sortedCats = [...categories].sort().join(',');
  if (config.enabledCategories.length > 0 && sortedCats !== [...config.enabledCategories].sort().join(',')) changes.enabledCategories = categories;
  const dirty = Object.keys(changes).length > 0;
  const floor = config.retentionFloor ?? 1;
  const ceiling = config.retentionCeiling ?? 365;
  const retentionOk = retention >= floor && retention <= ceiling;

  const globalOff = (v: boolean | null) => (v === false ? <span className="badge badge-warn">Off district-wide</span> : null);

  return (
    <div className="card stack-lg">
      <h2>Settings</h2>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Student features</legend>
        <label className="row">
          <input type="checkbox" checked={studentPosting} onChange={(e) => setStudentPosting(e.target.checked)} />
          Students can post found items {globalOff(config.globalStudentPosting)}
        </label>
        <p className="hint" style={{ margin: 0 }}>Keep this off for the first two weeks while staff post and students browse.</p>
        <label className="row">
          <input type="checkbox" checked={lostReports} onChange={(e) => setLostReports(e.target.checked)} />
          Students can file lost reports {globalOff(config.globalLostReports)}
        </label>
        <label className="row">
          <input type="checkbox" checked={crossSchool} onChange={(e) => setCrossSchool(e.target.checked)} />
          Include this school in cross-school search {globalOff(config.globalCrossSchoolSearch)}
        </label>
      </fieldset>
      <div className="grid">
        <label className="field">
          <span className="label">Retention after check-in (days)</span>
          <input className="input" type="number" min={floor} max={ceiling} value={retention} onChange={(e) => setRetention(Number(e.target.value))} aria-invalid={!retentionOk} />
          <span className={retentionOk ? 'hint' : 'field-error'}>
            District range: {floor} to {ceiling} days.
          </span>
        </label>
        <label className="field">
          <span className="label">School days to drop off</span>
          <input className="input" type="number" min={1} max={10} value={neverArrived} onChange={(e) => setNeverArrived(Number(e.target.value))} />
          <span className="hint">1 means by the end of the next school day.</span>
        </label>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Categories students can post</legend>
        <div className="grid">
          {STUDENT_CATEGORIES.map((c) => (
            <label key={c} className="row">
              <input
                type="checkbox"
                checked={categories.includes(c)}
                onChange={(e) => setCategories((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
              />
              {categoryLabel(c)}
            </label>
          ))}
        </div>
        <p className="hint" style={{ margin: 0 }}>Phones, wallets, keys, IDs, and medication always go straight to the office.</p>
      </fieldset>
      {saved ? (
        <div className="notice notice-ok" role="status">
          {saved}
        </div>
      ) : null}
      <ConfirmButton
        label="Save settings"
        prompt={`Save ${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? '' : 's'}? Settings changes need a recent sign-in.`}
        confirmLabel="Save"
        disabled={!dirty || !retentionOk || categories.length === 0}
        onConfirm={async () => {
          await staffApi(`/api/staff/${code}/config`, { method: 'PATCH', body: { changes } });
          setSaved('Settings saved.');
          router.refresh();
        }}
      />
    </div>
  );
}
