// /district: overview with system health and in-app alerts (§17: the dashboard banner is the only
// alert channel; nobody is paged) plus the school list.
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { buttonClass } from '@/components/ui/button.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { IconBell, IconBuilding, IconPlus, IconShieldCheck, IconSliders } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { Stat, StatGrid } from '@/components/ui/stat.tsx';
import { Table } from '@/components/ui/table.tsx';
import { fmtDateTime, humanize, type Tone } from '@/components/staff/format.ts';
import { alertsOf } from '@/components/staff/shapes.ts';
import { api } from '@/lib/db.ts';
import { districtCall, districtSchools, load, requireDistrict, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'District overview - Recover' };

type Health = {
  db?: boolean;
  oldestJobS?: number | null;
  deadJobs?: number | null;
  calendarHorizonD?: number | null;
  deletionUnverifiedMaxAgeS?: number | null;
  workerHeartbeatAgeS?: number | null;
};

type Tile = { label: string; value: string; tone: Tone; note: string };

function minutes(s: number): string {
  return s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
}

// Thresholds from §17 alerts.
function tiles(h: Health): Tile[] {
  const out: Tile[] = [];
  out.push({ label: 'Database', value: h.db === false ? 'Down' : 'Up', tone: h.db === false ? 'danger' : 'ok', note: '' });
  if (typeof h.oldestJobS === 'number') out.push({ label: 'Oldest queued job', value: minutes(h.oldestJobS), tone: h.oldestJobS > 600 ? 'warn' : 'ok', note: 'Alert above 10 min' });
  if (typeof h.deadJobs === 'number') out.push({ label: 'Dead jobs', value: String(h.deadJobs), tone: h.deadJobs > 0 ? 'danger' : 'ok', note: 'Any dead job needs a look' });
  if (typeof h.workerHeartbeatAgeS === 'number') out.push({ label: 'Worker last seen', value: minutes(h.workerHeartbeatAgeS), tone: h.workerHeartbeatAgeS > 300 ? 'warn' : 'ok', note: 'Runs every minute' });
  if (typeof h.calendarHorizonD === 'number') out.push({ label: 'Calendar coverage', value: `${h.calendarHorizonD} d`, tone: h.calendarHorizonD < 45 ? 'warn' : 'ok', note: 'Warn under 45 days' });
  if (typeof h.deletionUnverifiedMaxAgeS === 'number') {
    const s = h.deletionUnverifiedMaxAgeS;
    out.push({ label: 'Oldest unverified deletion', value: minutes(s), tone: s > 86400 ? 'danger' : s > 3600 ? 'warn' : 'ok', note: 'Warn over 1 h, high over 24 h' });
  }
  return out;
}

const SEVERITY_TONE: Record<string, Tone> = { critical: 'danger', high: 'danger', warning: 'warn', warn: 'warn', info: 'brand' };

export default async function DistrictOverview() {
  const r = await requireDistrict('/district');
  const [health, alerts, schools] = await Promise.all([
    load('page.district.health', () => api<Health>('api_health')),
    load('page.district.alerts', async () => alertsOf(await districtCall<unknown>(r, 'api_district_alerts', { p_limit: 50 }))),
    load('page.district.schools', () => districtSchools(r.sub)),
  ]);

  return (
    <>
      <PageHeader title={<>District overview</>} description={<>Health checks, alerts from the last day, and every school in the district.</>} />
      <section className="stack" aria-labelledby="health-h">
        <h2 id="health-h" className="with-icon">
          <IconShieldCheck />
          System health
        </h2>
        {health.ok ? (
          <StatGrid>
            {tiles(health.data).map((t) => (
              <Stat
                key={t.label}
                value={t.value}
                label={t.label}
                tone={t.tone === 'warn' || t.tone === 'danger' ? t.tone : undefined}
                hint={
                  <>
                    <Badge tone={t.tone}>{t.tone === 'ok' ? 'OK' : t.tone === 'danger' ? 'Act now' : 'Check'}</Badge>
                    {t.note ? <span>{t.note}</span> : null}
                  </>
                }
              />
            ))}
          </StatGrid>
        ) : (
          <ErrorNotice code={health.code} what="Health" />
        )}
      </section>
      <section className="stack" aria-labelledby="alerts-h">
        <h2 id="alerts-h" className="with-icon">
          <IconBell />
          Alerts, last 24 hours
        </h2>
        {alerts.ok ? (
          alerts.data.length === 0 ? (
            <Notice tone="success">No alerts.</Notice>
          ) : (
            <ul className="alert-list">
              {alerts.data.map((a) => (
                <li key={a.id}>
                  <Notice
                    tone={SEVERITY_TONE[a.severity ?? ''] === 'danger' ? 'danger' : 'warning'}
                    title={
                      <>
                        {humanize(a.name)}
                        {a.schoolCode ? <Badge className="mono">{a.schoolCode}</Badge> : null}
                        {a.severity ? <Badge tone={SEVERITY_TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge> : null}
                      </>
                    }
                  >
                    <p className="small muted">
                      {fmtDateTime(a.createdAt)}
                      {a.detail ? ` - ${a.detail}` : ''}
                    </p>
                  </Notice>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ErrorNotice code={alerts.code} what="Alerts" signinHref={signinPath('/district')} />
        )}
      </section>
      <section className="stack" aria-labelledby="schools-h">
        <div className="spread">
          <h2 id="schools-h" className="with-icon">
            <IconBuilding />
            Schools
          </h2>
          <a className={buttonClass({})} href="/district/schools">
            <IconSliders />
            Manage schools
          </a>
        </div>
        {schools.ok ? (
          schools.data.length === 0 ? (
            <EmptyState
              icon={<IconBuilding />}
              title="No schools yet."
              actions={
                <a className={buttonClass({ variant: 'primary' })} href="/district/schools">
                  <IconPlus />
                  Add a school
                </a>
              }
            />
          ) : (
            <Table caption="Schools" hideCaption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {schools.data.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>{s.name}</td>
                    <td>{s.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td>
                      <div className="link-row">
                        <a href={`/staff/${s.code}/queue`}>Queue</a>
                        <a href={`/staff/${s.code}/stats`}>Dashboard</a>
                        <a href={`/district/schools?school=${s.code}`}>Onboarding</a>
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
