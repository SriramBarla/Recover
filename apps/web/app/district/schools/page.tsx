// /district/schools: school list, create, and the onboarding checklist per school (§24 and its
// implementation guide). The checklist status comes from api_district_onboarding.
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { fmtDateTime, humanize } from '@/components/staff/format.ts';
import { SchoolsManager } from '@/components/staff/SchoolsManager.tsx';
import { onboardingOf, type OnboardingStep } from '@/components/staff/shapes.ts';
import { SCHOOL_CODE_RE } from '@/lib/ops.ts';
import { districtCall, districtSchools, load, requireDistrict } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Schools - Recover' };

// The §24 steps with where each is done. Keys are this app's proposal for the step ids.
const GUIDE: { step: string; label: string; href: (code: string) => string | null }[] = [
  { step: 'school_created', label: 'School created with code, name, and timezone', href: () => null },
  { step: 'school_admin_invited', label: 'First school admin invited', href: (c) => `/staff/${c}/roster` },
  { step: 'calendar_coverage', label: 'At least 90 days of operating calendar loaded', href: (c) => `/staff/${c}/config` },
  { step: 'map_draft', label: 'Campus map draft uploaded and processed', href: (c) => `/staff/${c}/map` },
  { step: 'locations_pinned', label: 'Every active pickup location pinned on the map', href: (c) => `/staff/${c}/locations` },
  { step: 'zones_defined', label: 'At least one public zone defined', href: (c) => `/staff/${c}/map` },
  { step: 'map_activated', label: 'District safety review done and map activated', href: () => '/district/maps' },
  { step: 'staff_invited', label: 'Reviewers and office staff added', href: (c) => `/staff/${c}/roster` },
  { step: 'backfill', label: 'Current shelf backfilled', href: (c) => `/staff/${c}/post?mode=backfill` },
  { step: 'student_posting', label: 'Student posting turned on after two staff-only weeks', href: (c) => `/staff/${c}/config` },
];

function Checklist({ code, steps }: { code: string; steps: OnboardingStep[] | null }) {
  const byStep = new Map((steps ?? []).map((s) => [s.step, s]));
  const extra = (steps ?? []).filter((s) => !GUIDE.some((g) => g.step === s.step));
  return (
    <ol className="stack" style={{ paddingLeft: '1.25rem' }}>
      {GUIDE.map((g) => {
        const s = byStep.get(g.step);
        const href = g.href(code);
        return (
          <li key={g.step}>
            <span className="row">
              {steps ? <span className={s?.done ? 'badge badge-ok' : 'badge badge-warn'}>{s?.done ? 'Done' : 'To do'}</span> : null}
              <span>{s?.label ?? g.label}</span>
              {s?.doneAt ? <span className="small muted">{fmtDateTime(s.doneAt)}</span> : null}
              {href ? <a href={href}>Go</a> : null}
            </span>
            {s?.detail ? <div className="small muted">{s.detail}</div> : null}
          </li>
        );
      })}
      {extra.map((s) => (
        <li key={s.step}>
          <span className="row">
            <span className={s.done ? 'badge badge-ok' : 'badge badge-warn'}>{s.done ? 'Done' : 'To do'}</span>
            <span>{s.label ?? humanize(s.step)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default async function DistrictSchools({ searchParams }: PageProps<'/district/schools'>) {
  const r = await requireDistrict('/district/schools');
  const sp = await searchParams;
  const selected = typeof sp.school === 'string' && SCHOOL_CODE_RE.test(sp.school) ? sp.school : null;
  const [schools, onboarding] = await Promise.all([
    load('page.district.schools', () => districtSchools(r.sub)),
    selected ? load('page.district.onboarding', async () => onboardingOf(await districtCall<unknown>(r, 'api_district_onboarding', { p_school_code: selected }))) : Promise.resolve(null),
  ]);
  const school = selected && schools.ok ? schools.data.find((s) => s.code === selected) : undefined;

  return (
    <>
      <h1>Schools</h1>
      {selected ? (
        <section className="card stack" aria-labelledby="onb-h">
          <div className="spread">
            <h2 id="onb-h">Onboarding: {school?.name ?? selected}</h2>
            <a href="/district/schools">Close</a>
          </div>
          <p className="muted">About two hours of school-admin effort plus the backfill hour. Activation of the map is refused until its checks pass.</p>
          {onboarding && !onboarding.ok ? <ErrorNotice code={onboarding.code} what="Onboarding status" /> : null}
          <Checklist code={selected} steps={onboarding?.ok ? onboarding.data : null} />
        </section>
      ) : null}
      <SchoolsManager />
      <section className="stack" aria-labelledby="list-h">
        <h2 id="list-h">All schools</h2>
        {schools.ok ? (
          schools.data.length === 0 ? (
            <p className="muted">No schools yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Timezone</th>
                    <th scope="col">Status</th>
                    <th scope="col">Links</th>
                  </tr>
                </thead>
                <tbody>
                  {schools.data.map((s) => (
                    <tr key={s.id} aria-current={s.code === selected ? 'true' : undefined}>
                      <td className="mono">{s.code}</td>
                      <td>{s.name}</td>
                      <td className="small">{s.timezone ?? ''}</td>
                      <td>{s.active ? <span className="badge badge-ok">Active</span> : <span className="badge">Inactive</span>}</td>
                      <td className="row">
                        <a href={`/district/schools?school=${s.code}`}>Onboarding</a>
                        <a href={`/staff/${s.code}/queue`}>Open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <ErrorNotice code={schools.code} what="Schools" />
        )}
      </section>
    </>
  );
}
