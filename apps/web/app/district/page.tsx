// /district: overview with system health and in-app alerts (§17: the dashboard banner is the only
// alert channel; nobody is paged) plus the school list.
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { badgeClass, fmtDateTime, humanize, type Tone } from '@/components/staff/format.ts';
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
      <h1>District overview</h1>
      <section className="stack" aria-labelledby="health-h">
        <h2 id="health-h">System health</h2>
        {health.ok ? (
          <div className="kpis">
            {tiles(health.data).map((t) => (
              <div key={t.label} className="kpi">
                <div className="value">{t.value}</div>
                <div className="label">{t.label}</div>
                <span className={badgeClass(t.tone)}>{t.tone === 'ok' ? 'OK' : t.tone === 'danger' ? 'Act now' : 'Check'}</span>
                {t.note ? <div className="hint small">{t.note}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <ErrorNotice code={health.code} what="Health" />
        )}
      </section>
      <section className="stack" aria-labelledby="alerts-h">
        <h2 id="alerts-h">Alerts, last 24 hours</h2>
        {alerts.ok ? (
          alerts.data.length === 0 ? (
            <div className="notice notice-ok">No alerts.</div>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {alerts.data.map((a) => (
                <li key={a.id} className={`notice ${SEVERITY_TONE[a.severity ?? ''] === 'danger' ? 'notice-danger' : 'notice-warn'}`}>
                  <strong>{humanize(a.name)}</strong>
                  {a.schoolCode ? <span className="badge" style={{ marginLeft: '0.5rem' }}>{a.schoolCode}</span> : null}
                  {a.severity ? <span className={badgeClass(SEVERITY_TONE[a.severity] ?? 'neutral')} style={{ marginLeft: '0.5rem' }}>{a.severity}</span> : null}
                  <div className="small muted">
                    {fmtDateTime(a.createdAt)}
                    {a.detail ? ` - ${a.detail}` : ''}
                  </div>
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
          <h2 id="schools-h">Schools</h2>
          <a className="btn" href="/district/schools">
            Manage schools
          </a>
        </div>
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
                    <th scope="col">Status</th>
                    <th scope="col">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {schools.data.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.code}</td>
                      <td>{s.name}</td>
                      <td>{s.active ? <span className="badge badge-ok">Active</span> : <span className="badge">Inactive</span>}</td>
                      <td className="row">
                        <a href={`/staff/${s.code}/queue`}>Queue</a>
                        <a href={`/staff/${s.code}/stats`}>Dashboard</a>
                        <a href={`/district/schools?school=${s.code}`}>Onboarding</a>
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
