// /district/schools: school list, create, and the onboarding checklist per school (§24 and its
// implementation guide). The checklist status comes from api_district_onboarding.
import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge.tsx';
import { buttonClass } from '@/components/ui/button.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { IconBuilding, IconCheckCircle, IconList, IconX } from '@/components/ui/icons.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { Table } from '@/components/ui/table.tsx';
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
    <ol className="checklist">
      {GUIDE.map((g) => {
        const s = byStep.get(g.step);
        const href = g.href(code);
        return (
          <li key={g.step} data-done={s?.done ? 'true' : undefined}>
            <span className="checklist-row">
              {steps ? (
                <Badge tone={s?.done ? 'ok' : 'warn'} icon={s?.done ? <IconCheckCircle /> : undefined}>
                  {s?.done ? 'Done' : 'To do'}
                </Badge>
              ) : null}
              <span className="checklist-label">{s?.label ?? g.label}</span>
              {s?.doneAt ? <span className="small muted">{fmtDateTime(s.doneAt)}</span> : null}
              {href ? <a href={href}>Go</a> : null}
            </span>
            {s?.detail ? <div className="small muted">{s.detail}</div> : null}
          </li>
        );
      })}
      {extra.map((s) => (
        <li key={s.step} data-done={s.done ? 'true' : undefined}>
          <span className="checklist-row">
            <Badge tone={s.done ? 'ok' : 'warn'} icon={s.done ? <IconCheckCircle /> : undefined}>
              {s.done ? 'Done' : 'To do'}
            </Badge>
            <span className="checklist-label">{s.label ?? humanize(s.step)}</span>
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
      <PageHeader title={<>Schools</>} description={<>Add a school, then follow its onboarding checklist until students can post.</>} />
      {selected ? (
        <section className="card card-pad-lg stack" aria-labelledby="onb-h">
          <div className="spread">
            <h2 id="onb-h" className="with-icon">
              <IconList />
              Onboarding: {school?.name ?? selected}
            </h2>
            <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href="/district/schools">
              <IconX />
              Close
            </a>
          </div>
          <p className="muted">About two hours of school-admin effort plus the backfill hour. Activation of the map is refused until its checks pass.</p>
          {onboarding && !onboarding.ok ? <ErrorNotice code={onboarding.code} what="Onboarding status" /> : null}
          <Checklist code={selected} steps={onboarding?.ok ? onboarding.data : null} />
        </section>
      ) : null}
      <SchoolsManager />
      <section className="stack" aria-labelledby="list-h">
        <h2 id="list-h" className="with-icon">
          <IconBuilding />
          All schools
        </h2>
        {schools.ok ? (
          schools.data.length === 0 ? (
            <EmptyState icon={<IconBuilding />} title="No schools yet." />
          ) : (
            <Table caption="All schools" hideCaption>
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
                    <td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td>
                      <div className="link-row">
                        <a href={`/district/schools?school=${s.code}`}>Onboarding</a>
                        <a href={`/staff/${s.code}/queue`}>Open</a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        ) : (
          <ErrorNotice code={schools.code} what="Schools" />
        )}
      </section>
    </>
  );
}
