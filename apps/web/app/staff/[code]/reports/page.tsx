// /staff/[code]/reports: open lost reports at this school, without device data; staff can close
// them (G-43, closed_by_staff).
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { ReportsTable } from '@/components/staff/ReportsTable.tsx';
import { lostReportsOf } from '@/components/staff/shapes.ts';
import { canPerform } from '@/lib/ops.ts';
import { load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Lost reports - Recover' };

export default async function ReportsPage({ params }: PageProps<'/staff/[code]/reports'>) {
  const { code } = await params;
  const path = `/staff/${code}/reports`;
  const ctx = await requireStaff(code, { path });
  const [reports, meta] = await Promise.all([
    load('page.reports', async () => lostReportsOf(await schoolCall<unknown>(scopeOf(ctx), 'api_staff_lost_reports', { p_school_code: code }))),
    schoolMeta(code),
  ]);

  return (
    <>
      <div className="stack">
        <h1>Lost reports</h1>
        <p className="muted">What students reported losing here. Matching items show up on their device; nothing is sent anywhere.</p>
      </div>
      {reports.ok ? (
        <ReportsTable
          code={code}
          reports={reports.data}
          activeMap={meta?.map ?? null}
          tz={meta?.timezone ?? null}
          can={{ close: canPerform(ctx.role, 'report.close'), block: canPerform(ctx.role, 'device.block'), readMaps: canPerform(ctx.role, 'map.read') }}
        />
      ) : (
        <ErrorNotice code={reports.code} what="Lost reports" signinHref={signinPath(path)} />
      )}
    </>
  );
}
