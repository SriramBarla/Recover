'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Fieldset, TextInput } from '@/components/ui/field.tsx';
import { LiveRegion } from '@/components/ui/live-region.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { TextArea } from '@/components/ui/text-area.tsx';
import { ConfirmButton } from './ConfirmButton.tsx';
import { staffApi } from './client-api.ts';
import type { DistrictSettings } from './shapes.ts';

// District policy (§5.6): retention floor and ceiling, staff email domains, global switches (off
// always wins), the screening ceiling (F-67), and the worker mode used for restores (G-06). Only
// changed keys are sent; saving needs a recent sign-in (G-31).
export function DistrictSettingsForm({ settings }: { settings: DistrictSettings }) {
  const router = useRouter();
  const [floor, setFloor] = useState(settings.retentionDaysFloor ?? 14);
  const [ceiling, setCeiling] = useState(settings.retentionDaysCeiling ?? 60);
  const [domains, setDomains] = useState(settings.staffEmailDomains.join('\n'));
  const [posting, setPosting] = useState(settings.studentPostingGlobalEnabled ?? false);
  const [lost, setLost] = useState(settings.lostReportsGlobalEnabled ?? false);
  const [cross, setCross] = useState(settings.crossSchoolSearchGlobalEnabled ?? false);
  const [screening, setScreening] = useState(settings.screeningEnabled ?? true);
  const [screeningCeiling, setScreeningCeiling] = useState(settings.screeningDailyCeiling ?? 500);
  const [workerMode, setWorkerMode] = useState<'normal' | 'quarantine'>(settings.workerMode ?? 'normal');
  const [saved, setSaved] = useState('');

  const domainList = domains
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const changes: Record<string, unknown> = {};
  if (settings.retentionDaysFloor !== null && floor !== settings.retentionDaysFloor) changes.retentionDaysFloor = floor;
  if (settings.retentionDaysCeiling !== null && ceiling !== settings.retentionDaysCeiling) changes.retentionDaysCeiling = ceiling;
  if (domainList.join(',') !== settings.staffEmailDomains.map((d) => d.toLowerCase()).join(',')) changes.staffEmailDomains = domainList;
  if (settings.studentPostingGlobalEnabled !== null && posting !== settings.studentPostingGlobalEnabled) changes.studentPostingGlobalEnabled = posting;
  if (settings.lostReportsGlobalEnabled !== null && lost !== settings.lostReportsGlobalEnabled) changes.lostReportsGlobalEnabled = lost;
  if (settings.crossSchoolSearchGlobalEnabled !== null && cross !== settings.crossSchoolSearchGlobalEnabled) changes.crossSchoolSearchGlobalEnabled = cross;
  if (settings.screeningEnabled !== null && screening !== settings.screeningEnabled) changes.screeningEnabled = screening;
  if (settings.screeningDailyCeiling !== null && screeningCeiling !== settings.screeningDailyCeiling) changes.screeningDailyCeiling = screeningCeiling;
  if (settings.workerMode !== null && workerMode !== settings.workerMode) changes.workerMode = workerMode;
  const count = Object.keys(changes).length;
  const valid = floor >= 1 && ceiling >= floor && ceiling <= 365 && domainList.length > 0 && screeningCeiling >= 0;

  return (
    <div className="card card-pad-lg stack-lg">
      <Fieldset id="ds-retention" legend="Custody retention (days after check-in)" hint="A new range is refused while a school is outside it; adjust that school first." bodyClassName="fieldset-row">
        <TextInput id="ds-floor" label="Floor" type="number" inputMode="numeric" min={1} max={365} value={floor} onChange={(e) => setFloor(Number(e.target.value))} className="input-number" />
        <TextInput
          id="ds-ceiling"
          label="Ceiling"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          value={ceiling}
          onChange={(e) => setCeiling(Number(e.target.value))}
          aria-invalid={ceiling < floor}
          className="input-number"
        />
      </Fieldset>
      <TextArea
        id="ds-domains"
        label="Staff email domains (one per line)"
        className="mono"
        value={domains}
        onChange={(e) => setDomains(e.target.value)}
        aria-invalid={domainList.length === 0}
        hint="Exact domains only, for example district.k12.ga.us. Sign-in checks the whole domain, never a suffix."
        fieldClassName="field-measure"
      />
      <Fieldset id="ds-switches" legend="Global switches (off overrides every school)">
        <label className="choice">
          <input type="checkbox" checked={posting} onChange={(e) => setPosting(e.target.checked)} />
          Student posting
        </label>
        <label className="choice">
          <input type="checkbox" checked={lost} onChange={(e) => setLost(e.target.checked)} />
          Lost reports
        </label>
        <label className="choice">
          <input type="checkbox" checked={cross} onChange={(e) => setCross(e.target.checked)} />
          Cross-school search
        </label>
      </Fieldset>
      <Fieldset id="ds-screening" legend="Photo screening">
        <label className="choice">
          <input type="checkbox" checked={screening} onChange={(e) => setScreening(e.target.checked)} />
          Screening enabled
        </label>
        <TextInput
          id="ds-screening-ceiling"
          label="Daily image ceiling, district-wide"
          type="number"
          inputMode="numeric"
          min={0}
          value={screeningCeiling}
          onChange={(e) => setScreeningCeiling(Number(e.target.value))}
          hint="Over the ceiling, photos go to reviewers unscreened and flagged."
          className="input-number"
        />
      </Fieldset>
      <Fieldset id="ds-worker" legend="Worker mode">
        <label className="choice">
          <input type="radio" name="worker-mode" checked={workerMode === 'normal'} onChange={() => setWorkerMode('normal')} />
          Normal
        </label>
        <label className="choice">
          <input type="radio" name="worker-mode" checked={workerMode === 'quarantine'} onChange={() => setWorkerMode('quarantine')} />
          Quarantine (restore procedure: only reconciliation jobs run)
        </label>
        {workerMode === 'quarantine' && settings.workerMode !== 'quarantine' ? (
          <Notice tone="danger">Quarantine stops publishing, matching, deletion, and every other background job until it is turned off. Use it only during a restore.</Notice>
        ) : null}
      </Fieldset>
      <LiveRegion message={saved} />
      {saved ? <Notice tone="success">{saved}</Notice> : null}
      <ConfirmButton
        label="Save district settings"
        prompt={`Save ${count} change${count === 1 ? '' : 's'} for every school? Needs a recent sign-in.`}
        confirmLabel="Save"
        danger={workerMode === 'quarantine'}
        disabled={count === 0 || !valid}
        onConfirm={async () => {
          await staffApi('/api/district/settings', { method: 'PATCH', body: { changes } });
          setSaved('District settings saved.');
          router.refresh();
        }}
      />
    </div>
  );
}
