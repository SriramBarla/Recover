// /staff/[code]/roster: school admins invite staff, change roles, and deactivate (§5.5). Role and
// status changes need a recent sign-in (G-31).
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { RosterManager } from '@/components/staff/RosterManager.tsx';
import { rosterOf } from '@/components/staff/shapes.ts';
import { load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Roster - Recover' };

export default async function RosterPage({ params }: PageProps<'/staff/[code]/roster'>) {
  const { code } = await params;
  const path = `/staff/${code}/roster`;
  const ctx = await requireStaff(code, { min: 'school_admin', path });
  const [roster, meta] = await Promise.all([
    load('page.roster', async () => rosterOf(await schoolCall<unknown>(scopeOf(ctx), 'api_staff_roster_list', { p_school_code: code }))),
    schoolMeta(code),
  ]);

  return (
    <>
      <div className="stack">
        <h1>Roster</h1>
        <p className="muted">Staff sign in with their district Google account. Only people on this roster can sign in to {ctx.school.name}.</p>
      </div>
      {roster.ok ? (
        <RosterManager code={code} members={roster.data} canRebind={ctx.isDistrict} tz={meta?.timezone ?? null} />
      ) : (
        <ErrorNotice code={roster.code} what="Roster" signinHref={signinPath(path)} />
      )}
    </>
  );
}
