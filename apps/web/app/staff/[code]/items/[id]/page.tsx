// /staff/[code]/items/[id]: one item with every state, the custody timeline, and the actions the
// role and state allow (§5.3-5.4, Appendix C).
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { StaffItemRow } from '@recover/shared/dto.ts';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import {
  CUSTODY_LABELS,
  PUBLICATION_LABELS,
  REVIEW_LABELS,
  badgeClass,
  categoryLabel,
  chipsFor,
  fmtDateTime,
  label,
} from '@/components/staff/format.ts';
import { ItemActions, type ItemCan } from '@/components/staff/ItemActions.tsx';
import { ItemPhotos } from '@/components/staff/ItemPhotos.tsx';
import { ItemPin } from '@/components/staff/ItemPin.tsx';
import { itemOf } from '@/components/staff/shapes.ts';
import { atLeast, canPerform, isUuid } from '@/lib/ops.ts';
import { load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath, type StaffMeta } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Item - Recover' };

type Step = { key: string; label: string; at: string | null; state: 'done' | 'current' | 'upcoming' | 'missed' };

// Timeline from the fields StaffItemRow carries (posted, deadline, retention, disposition due,
// terminal custody). Exact received/claimed times live in the audit log, not in this DTO.
function timeline(item: StaffItemRow): Step[] {
  const c = item.custody;
  const received = c !== 'with_finder' && c !== 'expired_never_arrived';
  const steps: Step[] = [{ key: 'posted', label: `Posted by ${item.postedByKind === 'student' ? 'a student' : 'staff'}`, at: item.createdAt, state: 'done' }];
  if (item.postedByKind === 'student') {
    steps.push({
      key: 'deadline',
      label: 'Drop-off deadline',
      at: item.arrivalDeadlineAt,
      state: c === 'expired_never_arrived' ? 'missed' : received ? 'done' : 'current',
    });
  }
  if (c === 'expired_never_arrived') {
    steps.push({ key: 'never', label: 'Never arrived (late check-in still possible within the grace window)', at: null, state: 'current' });
    return steps;
  }
  steps.push({ key: 'received', label: 'Checked in at a location', at: null, state: received ? 'done' : 'upcoming' });
  if (item.expiresAt) steps.push({ key: 'expires', label: 'Retention period ends', at: item.expiresAt, state: item.dispositionDueAt ? 'done' : 'upcoming' });
  if (item.dispositionDueAt) steps.push({ key: 'due', label: 'Disposition due', at: item.dispositionDueAt, state: c === 'at_location' ? 'current' : 'done' });
  if (c === 'claimed' || c === 'expired_donated' || c === 'expired_disposed') {
    steps.push({ key: 'end', label: CUSTODY_LABELS[c], at: null, state: 'done' });
  } else if (c === 'at_location') {
    steps.push({ key: 'end', label: 'Claimed, donated, or disposed', at: null, state: 'upcoming' });
  }
  return steps;
}

const STEP_BADGE: Record<Step['state'], string> = { done: 'badge badge-ok', current: 'badge badge-brand', upcoming: 'badge', missed: 'badge badge-danger' };
const STEP_TEXT: Record<Step['state'], string> = { done: 'Done', current: 'Now', upcoming: 'Later', missed: 'Missed' };

function locationName(meta: StaffMeta | null, id: string | null): string {
  if (!id) return 'None';
  return meta?.locations.find((l) => l.id === id)?.name ?? 'Inactive or unknown location';
}

export default async function ItemPage({ params }: PageProps<'/staff/[code]/items/[id]'>) {
  const { code, id } = await params;
  if (!isUuid(id)) notFound();
  const path = `/staff/${code}/items/${id}`;
  const ctx = await requireStaff(code, { path });
  const [loaded, meta] = await Promise.all([
    load('page.item', async () => itemOf(await schoolCall<unknown>(scopeOf(ctx), 'api_staff_item_get', { p_school_code: code, p_item_id: id }))),
    schoolMeta(code),
  ]);
  if (!loaded.ok) {
    return (
      <>
        <h1>Item</h1>
        <ErrorNotice code={loaded.code} what="Item" signinHref={signinPath(path)} />
        <a href={`/staff/${code}/queue`}>Back to the queue</a>
      </>
    );
  }
  const item = loaded.data;
  if (!item) notFound();
  const role = ctx.role;
  const can: ItemCan = {
    approve: canPerform(role, 'item.approve'),
    receive: canPerform(role, 'item.receive'),
    transfer: canPerform(role, 'item.transfer'),
    claim: canPerform(role, 'item.claim'),
    dispose: canPerform(role, 'item.dispose'),
    pull: canPerform(role, 'item.pull'),
    edit: canPerform(role, 'item.edit'),
    del: canPerform(role, 'item.delete'),
    confirmPublish: canPerform(role, 'item.confirm_publish'),
    dropPhoto: canPerform(role, 'item.photo_drop'),
    block: canPerform(role, 'device.block'),
  };
  const tz = meta?.timezone ?? null;
  const chips = chipsFor(item.flags, item.screeningStatus);
  const title = `${categoryLabel(item.category)} ${item.publicId ?? ''}`.trim();

  return (
    <>
      <div className="stack">
        <a href={`/staff/${code}/queue`} className="small">
          Back to the queue
        </a>
        <h1>
          {categoryLabel(item.category)} <span className="mono muted" style={{ fontSize: '1rem' }}>{item.publicId ?? 'No public id yet'}</span>
        </h1>
        <ul className="chips" aria-label="Item state" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          <li className="badge badge-brand">Review: {label(REVIEW_LABELS, item.reviewStatus)}</li>
          <li className="badge">Listing: {label(PUBLICATION_LABELS, item.publicationStatus)}</li>
          <li className="badge">Custody: {label(CUSTODY_LABELS, item.custody)}</li>
          {chips.map((c) => (
            <li key={c.key} className={badgeClass(c.tone)}>
              {c.label}
            </li>
          ))}
        </ul>
      </div>
      {item.quarantine ? (
        <div className="notice notice-danger" role="alert">
          <strong>Quarantined by automated screening.</strong>{' '}
          {atLeast(role, 'school_admin') ? 'Do not download or share it. Follow the district incident contact tree before acting.' : 'Ask a school admin.'}
        </div>
      ) : null}
      <div className="grid-wide">
        <section className="card stack" aria-labelledby="item-photos">
          <h2 id="item-photos">Photos</h2>
          <ItemPhotos code={code} item={item} blurred={item.quarantine} />
        </section>
        <section className="card stack" aria-labelledby="item-details">
          <h2 id="item-details">Details</h2>
          <dl className="stack small" style={{ margin: 0 }}>
            <div>
              <dt className="label">Description (public once published)</dt>
              <dd style={{ margin: 0 }}>{item.description ?? <span className="muted">Cleared</span>}</dd>
            </div>
            <div>
              <dt className="label">Finder's location note (staff only)</dt>
              <dd style={{ margin: 0 }}>{item.note ?? <span className="muted">None</span>}</dd>
            </div>
            <div>
              <dt className="label">Exact pin (staff only)</dt>
              <dd style={{ margin: 0 }}>
                <ItemPin code={code} pin={item.pin} mapVersionId={item.mapVersionId} activeMap={meta?.map ?? null} canReadMaps={canPerform(role, 'map.read')} label={title} />
              </dd>
            </div>
            <div>
              <dt className="label">Public zone</dt>
              <dd style={{ margin: 0 }}>{item.zoneName ?? <span className="muted">None</span>}</dd>
            </div>
            <div>
              <dt className="label">Drop-off location</dt>
              <dd style={{ margin: 0 }}>{locationName(meta, item.dropoffLocationId)}</dd>
            </div>
            <div>
              <dt className="label">Current location</dt>
              <dd style={{ margin: 0 }}>{locationName(meta, item.currentLocationId)}</dd>
            </div>
            <div>
              <dt className="label">Device rejections, last 30 days</dt>
              <dd style={{ margin: 0 }}>{item.deviceRejections30d === null ? <span className="muted">Not applicable</span> : item.deviceRejections30d}</dd>
            </div>
          </dl>
        </section>
      </div>
      <section className="card stack" aria-labelledby="item-timeline">
        <h2 id="item-timeline">Custody timeline</h2>
        <ol className="stack" style={{ paddingLeft: '1.25rem', margin: 0 }}>
          {timeline(item).map((s) => (
            <li key={s.key}>
              <span className="row">
                <span className={STEP_BADGE[s.state]}>{STEP_TEXT[s.state]}</span>
                <span>{s.label}</span>
                {s.at ? <span className="muted small">{fmtDateTime(s.at, tz)}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>
      <ItemActions key={item.rowVersion} code={code} item={item} can={can} meta={meta} />
    </>
  );
}
