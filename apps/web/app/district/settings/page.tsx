// /district/settings: retention floor and ceiling, staff email domains, global switches, the
// screening ceiling, and the worker mode (§5.6; F-64, F-67, G-06).
import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { DistrictSettingsForm } from '@/components/staff/DistrictSettingsForm.tsx';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { districtSettingsOf } from '@/components/staff/shapes.ts';
import { districtCall, load, requireDistrict, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'District settings - Recover' };

export default async function DistrictSettingsPage() {
  const r = await requireDistrict('/district/settings');
  const settings = await load('page.district.settings', async () => districtSettingsOf(await districtCall<unknown>(r, 'api_district_settings_get')));
  return (
    <>
      <PageHeader title={<>District settings</>} description={<>These apply to every school. Changes are audited.</>} />
      {settings.ok ? (
        <DistrictSettingsForm settings={settings.data} />
      ) : (
        <ErrorNotice code={settings.code} what="Settings" signinHref={signinPath('/district/settings')} />
      )}
    </>
  );
}
