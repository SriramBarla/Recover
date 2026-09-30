// /staff/[code]/map: map versions, draft upload through the worker broker, zones, and submission for
// district approval (§5.5; §24 steps 2-3; G-07).
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { MapEditor } from '@/components/staff/MapEditor.tsx';
import { mapVersionsOf } from '@/components/staff/shapes.ts';
import { load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Campus map - Recover' };

export default async function MapPage({ params }: PageProps<'/staff/[code]/map'>) {
  const { code } = await params;
  const path = `/staff/${code}/map`;
  const ctx = await requireStaff(code, { min: 'school_admin', path });
  const [versions, meta] = await Promise.all([
    load('page.map', async () => mapVersionsOf(await schoolCall<unknown>(scopeOf(ctx), 'api_staff_map_versions', { p_school_code: code }))),
    schoolMeta(code),
  ]);

  return (
    <>
      <div className="stack">
        <h1>Campus map</h1>
        <p className="muted">
          Students pin found items on the district-approved public map and see only zone names, never exact pins. Drafts stay private until the district
          activates them.
        </p>
      </div>
      {versions.ok ? (
        <MapEditor code={code} versions={versions.data} tz={meta?.timezone ?? null} />
      ) : (
        <ErrorNotice code={versions.code} what="Map versions" signinHref={signinPath(path)} />
      )}
    </>
  );
}
