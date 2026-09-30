// /staff: school picker (§5.3 step 1: land on the queue; multi-school staff pick).
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Badge } from '@/components/ui/badge.tsx';
import { buttonClass } from '@/components/ui/button.tsx';
import { IconAlert, IconBuilding, IconChevronRight, IconShield } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { ROLE_LABELS } from '@/components/staff/format.ts';
import { SessionKeepAlive } from '@/components/staff/SessionKeepAlive.tsx';
import { TopBar } from '@/components/staff/TopBar.tsx';
import { districtSchools, isDistrictAdmin, load, resolveStaff, schoolMemberships, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Choose a school - Recover' };

export default async function StaffHome() {
  const r = await resolveStaff();
  if (!r) redirect(signinPath('/staff'));
  const mine = schoolMemberships(r);
  const district = isDistrictAdmin(r);
  const first = mine[0];
  if (!district && mine.length === 1 && first?.schoolCode) redirect(`/staff/${first.schoolCode}/queue`);
  const all = district ? await load('page.picker', () => districtSchools(r.sub)) : null;

  return (
    <>
      <TopBar
        brandHref="/staff"
        userLabel={r.user.displayName ?? r.user.email}
        links={
          district ? (
            <a className={buttonClass({ variant: 'ghost', size: 'sm' })} href="/district">
              <IconShield />
              District admin
            </a>
          ) : null
        }
      />
      <SessionKeepAlive />
      <main id="main" className="container-narrow stack-lg compact">
        <PageHeader title="Choose a school" description="Pick the school you are working on. You can switch at any time from the top bar." />
        {mine.length === 0 && !district ? (
          <Notice tone="warning">You do not have an active membership at any school. Ask your school admin to add you.</Notice>
        ) : null}
        {mine.length > 0 ? (
          <ul className="item-list">
            {mine.map((m) => (
              <li key={m.memberId || m.schoolCode}>
                <a className="card-link" href={`/staff/${m.schoolCode}/queue`}>
                  <div className="card spread">
                    <span className="with-icon">
                      <IconBuilding />
                      <span>
                        <strong>{m.schoolName ?? m.schoolCode}</strong> <span className="school-switcher-code">{m.schoolCode}</span>
                      </span>
                    </span>
                    <span className="chips">
                      <Badge tone="brand">{ROLE_LABELS[m.role]}</Badge>
                      <IconChevronRight className="muted" />
                    </span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {all ? (
          <section className="stack">
            <h2>All schools (district admin)</h2>
            {all.ok ? (
              all.data.length === 0 ? (
                <p className="muted">No schools yet. Create one under District admin.</p>
              ) : (
                <ul className="grid">
                  {all.data.map((s) => (
                    <li key={s.id}>
                      <a className="card-link" href={`/staff/${s.code}/queue`}>
                        <div className="card stack-sm">
                          <strong className="with-icon">
                            <IconBuilding />
                            {s.name}
                          </strong>
                          <div>
                            <span className="school-switcher-code">{s.code}</span>
                          </div>
                          {!s.active ? <Badge tone="warn" icon={<IconAlert />}>Inactive</Badge> : null}
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <ErrorNotice code={all.code} what="Schools" />
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}
