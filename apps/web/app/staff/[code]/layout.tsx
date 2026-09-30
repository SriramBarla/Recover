// School-scoped staff shell: header with the school's section nav (aria-current) gated by role.
// Pages enforce access with requireStaff; this layout only renders chrome for a resolved context.
import { buttonClass } from '@/components/ui/button.tsx';
import { IconShield } from '@/components/ui/icons.tsx';
import { ROLE_LABELS } from '@/components/staff/format.ts';
import { sectionIcon } from '@/components/staff/nav-icons.tsx';
import { SessionKeepAlive } from '@/components/staff/SessionKeepAlive.tsx';
import { TopBar } from '@/components/staff/TopBar.tsx';
import { pagesFor } from '@/lib/ops.ts';
import { getStaffContext, schoolMemberships } from '@/lib/staff.ts';

export default async function SchoolLayout({ children, params }: LayoutProps<'/staff/[code]'>) {
  const { code } = await params;
  // Chrome only: a failed lookup renders the header without nav; the page reports the error.
  const ctx = await getStaffContext(code).catch(() => null);
  const items = ctx ? pagesFor(ctx.role).map((p) => ({ href: `/staff/${code}/${p.seg}`, label: p.label, icon: sectionIcon(p.seg) })) : [];
  const schools = ctx
    ? schoolMemberships(ctx).flatMap((m) => (m.schoolCode ? [{ code: m.schoolCode, name: m.schoolName ?? m.schoolCode, href: `/staff/${m.schoolCode}/queue` }] : []))
    : [];
  const multi = ctx ? ctx.isDistrict || schools.length > 1 : false;
  const who = ctx ? `${ctx.user.displayName ?? ctx.user.email} (${ROLE_LABELS[ctx.role]})` : null;

  return (
    <>
      <TopBar
        brandHref="/staff"
        context={{
          label: 'Acting for',
          name: ctx ? ctx.school.name : code,
          code,
          schools: multi ? schools : undefined,
          allHref: multi ? '/staff' : undefined,
        }}
        items={items}
        navLabel={`${code} sections`}
        userLabel={who}
        links={
          ctx?.isDistrict ? (
            <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href="/district">
              <IconShield />
              District
            </a>
          ) : null
        }
      />
      {ctx ? <SessionKeepAlive /> : null}
      <main id="main" className="container stack-lg compact">
        {children}
      </main>
    </>
  );
}
