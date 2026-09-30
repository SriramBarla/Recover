// Dashboard rendering for api_staff_stats / api_district_stats (§17 metrics). The contract does not
// pin these shapes, so this renders numbers as KPI tiles (top level and one nested level) and arrays
// of objects as tables. No chart library (§18 budgets). Works in server and client components.
import { fmtDate, humanize } from './format.ts';
import { obj, type Obj } from './shapes.ts';

function fmtValue(key: string, v: unknown, tz?: string | null): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (/rate|ratio|share|pct|percent/i.test(key) && v >= 0 && v <= 1 && !Number.isInteger(v)) return `${(v * 100).toFixed(1)}%`;
    if (!Number.isInteger(v)) return v.toFixed(1);
    return v.toLocaleString('en-US');
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}(T|$)/.test(v) ? fmtDate(v, tz) : v;
  return '';
}

function kpiEntries(o: Obj): [string, number][] {
  return Object.entries(o).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]));
}

function columns(rows: Obj[]): string[] {
  const cols: string[] = [];
  for (const r of rows.slice(0, 50)) {
    for (const [k, v] of Object.entries(r)) {
      if (!cols.includes(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) cols.push(k);
    }
  }
  return cols.filter((c) => !/^(id|schoolId)$/.test(c));
}

export function StatsView({ data, tz }: { data: unknown; tz?: string | null }) {
  const root = obj(data) ?? {};
  const groups: { title: string | null; entries: [string, number][] }[] = [];
  const top = kpiEntries(root);
  if (top.length > 0) groups.push({ title: null, entries: top });
  for (const [k, v] of Object.entries(root)) {
    const inner = obj(v);
    if (inner) {
      const nums = kpiEntries(inner);
      if (nums.length > 0) groups.push({ title: humanize(k), entries: nums });
    }
  }
  const tables = Object.entries(root)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => ({ key: k, rows: (v as unknown[]).map(obj).filter((x): x is Obj => x !== null) }))
    .filter((t) => t.rows.length > 0);

  if (groups.length === 0 && tables.length === 0) return <p className="muted">No data for this period yet.</p>;

  return (
    <div className="stack-lg">
      {groups.map((g) => (
        <section key={g.title ?? 'totals'} className="stack" aria-label={g.title ?? 'Totals'}>
          {g.title ? <h3>{g.title}</h3> : null}
          <div className="kpis">
            {g.entries.map(([k, v]) => (
              <div key={k} className="kpi">
                <div className="value">{fmtValue(k, v, tz)}</div>
                <div className="label">{humanize(k)}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {tables.map((t) => {
        const cols = columns(t.rows);
        return (
          <section key={t.key} className="stack">
            <h3>{humanize(t.key)}</h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c} scope="col">
                        {humanize(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.slice(0, 400).map((r, i) => (
                    <tr key={i}>
                      {cols.map((c) => (
                        <td key={c}>{fmtValue(c, r[c], tz)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
