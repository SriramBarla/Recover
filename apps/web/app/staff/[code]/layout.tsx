// School-scoped staff shell: header with the school's section nav (aria-current) gated by role.
// Pages enforce access with requireStaff; this layout only renders chrome for a resolved context.
import { ROLE_LABELS } from '@/components/staff/format.ts';
import { NavLinks } from '@/components/staff/NavLinks.tsx';
import { SessionKeepAlive } from '@/components/staff/SessionKeepAlive.tsx';
import { TopBar } from '@/components/staff/TopBar.tsx';
import { pagesFor } from '@/lib/ops.ts';
import { getStaffContext, schoolMemberships } from '@/lib/staff.ts';

export default async function SchoolLayout({ children, params }: LayoutProps<'/staff/[code]'>) {
  const { code } = await params;
  const ctx = await getStaffContext(code);
  const items = ctx ? pagesFor(ctx.role).map((p) => ({ href: `/staff/${code}/${p.seg}`, label: p.label })) : [];
  const multi = ctx ? ctx.isDistrict || schoolMemberships(ctx).length > 1 : false;
  const who = ctx ? `${ctx.user.displayName ?? ctx.user.email} (${ROLE_LABELS[ctx.role]})` : null;

  return (
    <>
      <TopBar
        brandHref="/staff"
        context={ctx ? `${ctx.school.name} - ${code}` : code}
        nav={ctx ? <NavLinks items={items} label={`${code} sections`} /> : null}
        userLabel={who}
        links={
          <>
            {multi ? <a href="/staff">Switch school</a> : null}
            {ctx?.isDistrict ? <a href="/district">District</a> : null}
          </>
        }
      />
      {ctx ? <SessionKeepAlive /> : null}
      <main id="main" className="container stack-lg">
        {children}
      </main>
    </>
  );
}
