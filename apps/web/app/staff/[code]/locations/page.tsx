// /staff/[code]/locations: pickup locations (create, rename, hours, deactivate) and their pins on
// the active or a draft map (§5.5; §24 step 3).
import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { LocationsManager } from '@/components/staff/LocationsManager.tsx';
import { locationsOf, mapVersionsOf } from '@/components/staff/shapes.ts';
import { load, requireStaff, schoolCall, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Locations - Recover' };

export default async function LocationsPage({ params }: PageProps<'/staff/[code]/locations'>) {
  const { code } = await params;
  const path = `/staff/${code}/locations`;
  const ctx = await requireStaff(code, { min: 'school_admin', path });
  const scope = scopeOf(ctx);
  const [locations, versions] = await Promise.all([
    load('page.locations', async () => locationsOf(await schoolCall<unknown>(scope, 'api_staff_locations_list', { p_school_code: code }))),
    load('page.locations.maps', async () => mapVersionsOf(await schoolCall<unknown>(scope, 'api_staff_map_versions', { p_school_code: code }))),
  ]);

  return (
    <>
      <PageHeader title={<>Locations</>} description={<>Where students bring found items and where owners pick them up.</>} />
      {locations.ok ? (
        <LocationsManager code={code} locations={locations.data} versions={versions.ok ? versions.data : []} />
      ) : (
        <ErrorNotice code={locations.code} what="Locations" signinHref={signinPath(path)} />
      )}
      {!versions.ok ? <ErrorNotice code={versions.code} what="Map versions" /> : null}
    </>
  );
}
