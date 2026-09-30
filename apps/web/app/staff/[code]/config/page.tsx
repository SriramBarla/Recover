// /staff/[code]/config: school switches, retention, never-arrived days, categories, and the
// operating calendar (§5.5, §24).
import type { Metadata } from 'next';
import { CalendarUpload } from '@/components/staff/CalendarUpload.tsx';
import { ConfigForm } from '@/components/staff/ConfigForm.tsx';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { configOf } from '@/components/staff/shapes.ts';
import { load, requireStaff, schoolCall, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'School settings - Recover' };

export default async function ConfigPage({ params }: PageProps<'/staff/[code]/config'>) {
  const { code } = await params;
  const path = `/staff/${code}/config`;
  const ctx = await requireStaff(code, { min: 'school_admin', path });
  const config = await load('page.config', async () => configOf(await schoolCall<unknown>(scopeOf(ctx), 'api_staff_config_get', { p_school_code: code })));

  return (
    <>
      <div className="stack">
        <h1>School settings</h1>
        <p className="muted">A district switch that is off always wins over the school setting.</p>
      </div>
      {config.ok ? (
        <>
          <ConfigForm code={code} config={config.data} />
          <CalendarUpload code={code} horizonDays={config.data.calendarHorizonDays} lastDay={config.data.calendarLastDay} />
        </>
      ) : (
        <ErrorNotice code={config.code} what="Settings" signinHref={signinPath(path)} />
      )}
    </>
  );
}
