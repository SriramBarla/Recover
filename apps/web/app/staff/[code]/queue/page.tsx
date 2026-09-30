// /staff/[code]/queue: pending items, flagged first (§5.3; §10.2-10.4; G-40). Quarantined items are
// returned by SQL only to school_admin and above (G-24).
import type { Metadata } from 'next';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { QueueBoard } from '@/components/staff/QueueBoard.tsx';
import { queueOf } from '@/components/staff/shapes.ts';
import { atLeast, canPerform } from '@/lib/ops.ts';
import { load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Review queue - Recover' };

export default async function QueuePage({ params }: PageProps<'/staff/[code]/queue'>) {
  const { code } = await params;
  const path = `/staff/${code}/queue`;
  const ctx = await requireStaff(code, { path });
  const [queue, meta] = await Promise.all([
    load('page.queue', async () =>
      queueOf(await schoolCall<unknown>(scopeOf(ctx), 'api_staff_queue', { p_school_code: code, p_cursor_created: null, p_cursor_id: null })),
    ),
    schoolMeta(code),
  ]);
  const nowMs = Date.now();

  return (
    <>
      <div className="stack">
        <h1>Review queue</h1>
        <p className="muted">Nothing a student posts is visible until you approve it. Screening only flags photos for a closer look; you make the call.</p>
      </div>
      {queue.ok ? (
        <QueueBoard
          key={nowMs}
          code={code}
          initial={queue.data}
          meta={meta}
          canSeeQuarantine={atLeast(ctx.role, 'school_admin')}
          canReadMaps={canPerform(ctx.role, 'map.read')}
          nowMs={nowMs}
        />
      ) : (
        <ErrorNotice code={queue.code} what="Queue" signinHref={signinPath(path)} />
      )}
    </>
  );
}
