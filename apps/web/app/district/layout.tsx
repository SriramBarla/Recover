// District admin shell (§5.6). Pages enforce district_admin with requireDistrict.
import { buttonClass } from '@/components/ui/button.tsx';
import { IconBuilding } from '@/components/ui/icons.tsx';
import { sectionIcon } from '@/components/staff/nav-icons.tsx';
import { SessionKeepAlive } from '@/components/staff/SessionKeepAlive.tsx';
import { TopBar } from '@/components/staff/TopBar.tsx';
import { isDistrictAdmin, resolveStaff } from '@/lib/staff.ts';

const ITEMS = [
  { href: '/district', label: 'Overview', match: 'exact' as const, icon: sectionIcon('overview') },
  { href: '/district/schools', label: 'Schools', icon: sectionIcon('schools') },
  { href: '/district/maps', label: 'Map approvals', icon: sectionIcon('maps') },
  { href: '/district/settings', label: 'Settings', icon: sectionIcon('settings') },
  { href: '/district/stats', label: 'Stats', icon: sectionIcon('stats') },
];

export default async function DistrictLayout({ children }: LayoutProps<'/district'>) {
  // Chrome only: a failed lookup renders the header without nav; the page reports the error.
  const r = await resolveStaff().catch(() => null);
  const ok = r !== null && isDistrictAdmin(r);
  return (
    <>
      <TopBar
        brandHref="/district"
        context={{ label: 'Acting for', name: 'The whole district' }}
        items={ok ? ITEMS : []}
        navLabel="District sections"
        userLabel={r ? (r.user.displayName ?? r.user.email) : null}
        links={
          <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href="/staff">
            <IconBuilding />
            Schools
          </a>
        }
      />
      {ok ? <SessionKeepAlive /> : null}
      <main id="main" className="container stack-lg compact">
        {children}
      </main>
    </>
  );
}
