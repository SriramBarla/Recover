// /district/maps: map versions waiting for district approval, with preview, activate, and send back
// (§5.6; §24 step 3; G-07).
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { MapApprovals } from '@/components/staff/MapApprovals.tsx';
import { pendingMapsOf } from '@/components/staff/shapes.ts';
import { districtCall, districtSchools, load, requireDistrict, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Map approvals - Recover' };

export default async function DistrictMaps() {
  const r = await requireDistrict('/district/maps');
  const [pending, schools] = await Promise.all([
    load('page.district.maps', async () => pendingMapsOf(await districtCall<unknown>(r, 'api_district_maps_pending'))),
    load('page.district.maps.schools', () => districtSchools(r.sub)),
  ]);
  // Fill in the school code and name when the pending list carries only the school id.
  const maps = pending.ok
    ? pending.data.map((m) => {
        const s = schools.ok ? schools.data.find((x) => (m.schoolId && x.id === m.schoolId.toLowerCase()) || x.code === m.schoolCode) : undefined;
        return { ...m, schoolCode: m.schoolCode ?? s?.code ?? null, schoolName: m.schoolName ?? s?.name ?? null };
      })
    : [];

  return (
    <>
      <div className="stack">
        <h1>Map approvals</h1>
        <p className="muted">Schools prepare drafts; only the district publishes a map. Review the image and every public zone label before activating.</p>
      </div>
      {pending.ok ? <MapApprovals maps={maps} /> : <ErrorNotice code={pending.code} what="Pending maps" signinHref={signinPath('/district/maps')} />}
    </>
  );
}
