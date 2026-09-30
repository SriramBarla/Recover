'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { STUDENT_CATEGORIES } from '@recover/shared/dto.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { Fieldset, TextInput } from '@/components/ui/field.tsx';
import { IconSliders } from '@/components/ui/icons.tsx';
import { LiveRegion } from '@/components/ui/live-region.tsx';
import { Notice } from '@/components/ui/notice.tsx';
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

  const globalOff = (v: boolean | null) => (v === false ? <Badge tone="warn">Off district-wide</Badge> : null);
  const range = `District range: ${floor} to ${ceiling} days.`;

  return (
    <section className="card card-pad-lg stack-lg" aria-labelledby="settings-h">
      <h2 id="settings-h" className="with-icon">
        <IconSliders />
        Settings
      </h2>
      <Fieldset id="cfg-features" legend="Student features">
        <label className="choice">
          <input type="checkbox" checked={studentPosting} onChange={(e) => setStudentPosting(e.target.checked)} aria-describedby="cfg-posting-hint" />
          <span>
            Students can post found items {globalOff(config.globalStudentPosting)}
          </span>
        </label>
        <p className="hint choice-hint" id="cfg-posting-hint">
          Keep this off for the first two weeks while staff post and students browse.
        </p>
        <label className="choice">
          <input type="checkbox" checked={lostReports} onChange={(e) => setLostReports(e.target.checked)} />
          <span>
            Students can file lost reports {globalOff(config.globalLostReports)}
          </span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={crossSchool} onChange={(e) => setCrossSchool(e.target.checked)} />
          <span>
            Include this school in cross-school search {globalOff(config.globalCrossSchoolSearch)}
          </span>
        </label>
      </Fieldset>
      <div className="grid-wide">
        <TextInput
          id="cfg-retention"
          label="Retention after check-in (days)"
          type="number"
          inputMode="numeric"
          min={floor}
          max={ceiling}
          value={retention}
          onChange={(e) => setRetention(Number(e.target.value))}
          hint={retentionOk ? range : undefined}
          error={retentionOk ? undefined : range}
          className="input-number"
        />
        <TextInput
          id="cfg-never-arrived"
          label="School days to drop off"
          type="number"
          inputMode="numeric"
          min={1}
          max={10}
          value={neverArrived}
          onChange={(e) => setNeverArrived(Number(e.target.value))}
          hint="1 means by the end of the next school day."
          className="input-number"
        />
      </div>
      <Fieldset id="cfg-categories" legend="Categories students can post" hint="Phones, wallets, keys, IDs, and medication always go straight to the office." bodyClassName="choice-grid">
        {STUDENT_CATEGORIES.map((c) => (
          <label key={c} className="choice">
            <input
              type="checkbox"
              checked={categories.includes(c)}
              onChange={(e) => setCategories((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
            />
            <span className="with-icon">
              <CategoryIcon category={c} size={18} />
              {categoryLabel(c)}
            </span>
          </label>
        ))}
      </Fieldset>
      <LiveRegion message={saved} />
      {saved ? <Notice tone="success">{saved}</Notice> : null}
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
    </section>
  );
}
