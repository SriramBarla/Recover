// /s/[code]/lost/mine: this browser's lost reports and matches (§12.3). Read with the cookie-derived digest
// only; the response is never cached (dynamic page, and the service worker skips /s/).
import type { MyLostReport } from '@recover/shared/dto.ts';
import { MyLostReports, type ReportView } from '@/components/student/MyLostReports.tsx';
import { formatDay } from '@/components/student/format.ts';
import { deviceDigest, locationNames, metaForPage, titleFor } from '@/components/student/server.ts';
import { api } from '@/lib/db.ts';
import { toPublicLostReport } from '@/lib/storage-url.ts';

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Your lost reports');
}

function hasNew(r: MyLostReport): boolean {
  if (!r.matches?.length || !r.lastMatchedAt) return false;
  return !r.lastViewedAt || Date.parse(r.lastMatchedAt) > Date.parse(r.lastViewedAt);
}

export default async function MyLostReportsPage({ params }: Props) {
  const meta = await metaForPage((await params).code);
  const code = meta.school.code;
  const digest = await deviceDigest(meta.school.id);
  const rows = digest
    ? (await api<{ reports: MyLostReport[] }>('api_my_lost_reports', { p_school_code: code, p_device_digest: digest })).reports
    : [];
  const reports: ReportView[] = rows.map((r) => ({
    ...toPublicLostReport(r),
    hasNew: hasNew(r),
    expiresLabel: formatDay(r.expiresAt, meta.school.timezone),
  }));

  return (
    <div className="container-narrow stack-lg" style={{ padding: 0 }}>
      <h1>Your lost reports</h1>
      <p className="hint">Reports filed from this browser. Only you and school staff can see them.</p>
      <MyLostReports code={code} reports={reports} locationNames={locationNames(meta)} />
    </div>
  );
}
