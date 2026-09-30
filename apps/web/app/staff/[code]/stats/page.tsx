// /staff/[code]/stats: the school dashboard (§17) and its printable weekly report; school admins also
// see recent audit activity (§14.3).
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { fmtDateTime, humanize } from '@/components/staff/format.ts';
import { PrintButton } from '@/components/staff/PrintButton.tsx';
import { RangeForm } from '@/components/staff/RangeForm.tsx';
import { auditOf } from '@/components/staff/shapes.ts';
import { StatsView } from '@/components/staff/StatsView.tsx';
import { canPerform, rangeOf } from '@/lib/ops.ts';
import { load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'School dashboard - Recover' };

function safeRange(from: unknown, to: unknown): { from: string; to: string } {
  try {
    return rangeOf(from, to);
  } catch {
    return rangeOf(undefined, undefined);
  }
}

export default async function StatsPage({ params, searchParams }: PageProps<'/staff/[code]/stats'>) {
  const { code } = await params;
  const sp = await searchParams;
  const path = `/staff/${code}/stats`;
  const ctx = await requireStaff(code, { path });
  const { from, to } = safeRange(sp.from, sp.to);
  const scope = scopeOf(ctx);
  const showAudit = canPerform(ctx.role, 'audit.read');
  const [stats, audit, meta] = await Promise.all([
    load('page.stats', () => schoolCall<unknown>(scope, 'api_staff_stats', { p_school_code: code, p_from: from, p_to: to })),
    showAudit ? load('page.audit', async () => auditOf(await schoolCall<unknown>(scope, 'api_staff_audit', { p_school_code: code, p_limit: 50 }))) : Promise.resolve(null),
    schoolMeta(code),
  ]);
  const tz = meta?.timezone ?? null;

  return (
    <>
      <div className="spread">
        <div className="stack">
          <h1>{ctx.school.name} dashboard</h1>
          <p className="muted">
            {from} to {to}
          </p>
        </div>
        <PrintButton />
      </div>
      <RangeForm from={from} to={to} />
      {stats.ok ? <StatsView data={stats.data} tz={tz} /> : <ErrorNotice code={stats.code} what="Dashboard" signinHref={signinPath(path)} />}
      {audit ? (
        <section className="stack" aria-labelledby="audit-h">
          <h2 id="audit-h">Recent activity</h2>
          {audit.ok ? (
            audit.data.length === 0 ? (
              <p className="muted">No activity recorded yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Action</th>
                      <th scope="col">By</th>
                      <th scope="col">Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.map((a) => (
                      <tr key={a.id}>
                        <td className="small">{fmtDateTime(a.createdAt, tz)}</td>
                        <td>{humanize(a.action)}</td>
                        <td className="small">{a.actorKind ?? ''}</td>
                        <td className="small mono">{a.targetTable ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <ErrorNotice code={audit.code} what="Activity" />
          )}
        </section>
      ) : null}
    </>
  );
}
