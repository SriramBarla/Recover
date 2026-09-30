// District admin shell (§5.6). Pages enforce district_admin with requireDistrict.
import { NavLinks } from '@/components/staff/NavLinks.tsx';
import { SessionKeepAlive } from '@/components/staff/SessionKeepAlive.tsx';
import { TopBar } from '@/components/staff/TopBar.tsx';
import { isDistrictAdmin, resolveStaff } from '@/lib/staff.ts';

const ITEMS = [
  { href: '/district', label: 'Overview', exact: true },
  { href: '/district/schools', label: 'Schools' },
  { href: '/district/maps', label: 'Map approvals' },
  { href: '/district/settings', label: 'Settings' },
  { href: '/district/stats', label: 'Stats' },
];

export default async function DistrictLayout({ children }: LayoutProps<'/district'>) {
  const r = await resolveStaff();
  const ok = r !== null && isDistrictAdmin(r);
  return (
    <>
      <TopBar
        brandHref="/district"
        context="District admin"
        nav={ok ? <NavLinks items={ITEMS} label="District sections" /> : null}
        userLabel={r ? (r.user.displayName ?? r.user.email) : null}
        links={<a href="/staff">Schools</a>}
      />
      {ok ? <SessionKeepAlive /> : null}
      <main id="main" className="container stack-lg">
        {children}
      </main>
    </>
  );
}
