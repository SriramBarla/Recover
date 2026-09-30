// /staff: school picker (§5.3 step 1: land on the queue; multi-school staff pick).
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
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
      <TopBar brandHref="/staff" context="Staff" userLabel={r.user.displayName ?? r.user.email} links={district ? <a href="/district">District admin</a> : null} />
      <SessionKeepAlive />
      <main id="main" className="container-narrow stack-lg">
        <h1>Choose a school</h1>
        {mine.length === 0 && !district ? (
          <div className="notice notice-warn">You do not have an active membership at any school. Ask your school admin to add you.</div>
        ) : null}
        {mine.length > 0 ? (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {mine.map((m) => (
              <li key={m.memberId || m.schoolCode}>
                <a className="card-link" href={`/staff/${m.schoolCode}/queue`}>
                  <div className="card spread">
                    <span>
                      <strong>{m.schoolName ?? m.schoolCode}</strong> <span className="muted mono small">{m.schoolCode}</span>
                    </span>
                    <span className="badge">{ROLE_LABELS[m.role]}</span>
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
                <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>
                  {all.data.map((s) => (
                    <li key={s.id}>
                      <a className="card-link" href={`/staff/${s.code}/queue`}>
                        <div className="card">
                          <strong>{s.name}</strong>
                          <div className="muted mono small">{s.code}</div>
                          {!s.active ? <span className="badge badge-warn">Inactive</span> : null}
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
