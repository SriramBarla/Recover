// /district/stats: adoption, recovery, queue age, abuse, and cost drivers per school (§5.6, §17),
// printable as the weekly report.
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { PrintButton } from '@/components/staff/PrintButton.tsx';
import { RangeForm } from '@/components/staff/RangeForm.tsx';
import { StatsView } from '@/components/staff/StatsView.tsx';
import { rangeOf } from '@/lib/ops.ts';
import { districtCall, load, requireDistrict, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'District stats - Recover' };

export default async function DistrictStats({ searchParams }: PageProps<'/district/stats'>) {
  const r = await requireDistrict('/district/stats');
  const sp = await searchParams;
  let range: { from: string; to: string };
  try {
    range = rangeOf(sp.from, sp.to);
  } catch {
    range = rangeOf(undefined, undefined);
  }
  const stats = await load('page.district.stats', () => districtCall<unknown>(r, 'api_district_stats', { p_from: range.from, p_to: range.to }));

  return (
    <>
      <div className="spread">
        <div className="stack">
          <h1>District stats</h1>
          <p className="muted">
            {range.from} to {range.to}
          </p>
        </div>
        <PrintButton />
      </div>
      <RangeForm from={range.from} to={range.to} />
      {stats.ok ? <StatsView data={stats.data} /> : <ErrorNotice code={stats.code} what="Stats" signinHref={signinPath('/district/stats')} />}
    </>
  );
}
