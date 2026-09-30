// /staff/[code]/custody: expected arrivals, items at a location, disposition-due items, and bulk
// dispose (§5.4). "Staff types or scans the ID" is the find box.
// Lists come from the proposed api_staff_custody_list; until that exists the page falls back to the
// public feed (published items only) and the disposition-due list is unavailable.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { FeedPage, ListingRow, PublicItemRow } from '@recover/shared/dto.ts';
import { toPublicError } from '@recover/shared/errors.ts';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconSearch } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { CustodyBoard } from '@/components/staff/CustodyBoard.tsx';
import { ErrorNotice } from '@/components/staff/ErrorNotice.tsx';
import { custodyListsOf, type CustodyLists, type CustodyRow } from '@/components/staff/shapes.ts';
import { api } from '@/lib/db.ts';
import { storagePublicUrl } from '@/lib/env.ts';
import { UUID_RE, canPerform } from '@/lib/ops.ts';
import { isUndefinedFunction, load, requireStaff, schoolCall, schoolMeta, scopeOf, signinPath, type StaffContext } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Custody - Recover' };

function publicRow(i: PublicItemRow): CustodyRow {
  const thumb = [...i.photos].sort((a, b) => a.position - b.position)[0]?.thumbPath ?? null;
  let url: string | null = null;
  try {
    url = thumb ? storagePublicUrl('variants', thumb) : null;
  } catch {
    url = null;
  }
  return {
    id: i.id,
    publicId: i.publicId,
    category: i.category,
    description: i.description,
    custody: i.custody,
    locationId: i.locationId,
    postedAt: i.foundAt,
    receivedAt: i.receivedAt,
    deadlineAt: null,
    expiresAt: null,
    dispositionDueAt: null,
    rowVersion: i.rowVersion,
    thumb: url,
    reviewStatus: 'approved',
  };
}

async function custodyLists(ctx: StaffContext, code: string): Promise<{ lists: CustodyLists; fallback: boolean }> {
  try {
    const r = await schoolCall<unknown>(scopeOf(ctx), 'api_staff_custody_list', { p_school_code: code, p_location_id: null });
    return { lists: custodyListsOf(r, code), fallback: false };
  } catch (e) {
    if (!isUndefinedFunction(e)) throw e;
  }
  // Fallback: published items from the public feed (at most 10 pages of 30).
  const rows: PublicItemRow[] = [];
  let cursor: FeedPage['nextCursor'] = null;
  for (let page = 0; page < 10; page += 1) {
    const feed: FeedPage = await api<FeedPage>('api_get_feed', {
      p_school_code: code,
      p_cursor_created: cursor?.createdAt ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_location_id: null,
      p_category: null,
      p_since: null,
    });
    rows.push(...(Array.isArray(feed?.items) ? feed.items : []));
    cursor = feed?.nextCursor ?? null;
    if (!cursor) break;
  }
  const mapped = rows.map(publicRow);
  return {
    lists: {
      expected: mapped.filter((r) => r.custody === 'with_finder'),
      atLocation: mapped.filter((r) => r.custody === 'at_location'),
      dispositionDue: null,
    },
    fallback: true,
  };
}

function one(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default async function CustodyPage({ params, searchParams }: PageProps<'/staff/[code]/custody'>) {
  const { code } = await params;
  const sp = await searchParams;
  const path = `/staff/${code}/custody`;
  const ctx = await requireStaff(code, { min: 'office', path });

  // Find by item id: an item uuid, or a public id such as FCHS-W-000214 (published items).
  const find = one(sp.find);
  let findError: string | null = null;
  if (find) {
    if (UUID_RE.test(find)) redirect(`/staff/${code}/items/${find.toLowerCase()}`);
    const publicId = find.toUpperCase();
    if (!/^[A-Z0-9-]{3,32}$/.test(publicId)) {
      findError = 'That does not look like an item id.';
    } else {
      let id: string | null = null;
      try {
        id = (await api<ListingRow>('api_get_item', { p_school_code: code, p_public_id: publicId }))?.id ?? null;
      } catch (e) {
        findError = toPublicError(e).code === 'not_found' ? `No published item ${publicId} here. Pending items are in the queue.` : 'Search failed. Please try again.';
      }
      if (id) redirect(`/staff/${code}/items/${id}`);
    }
  }

  const [loaded, meta] = await Promise.all([load('page.custody', () => custodyLists(ctx, code)), schoolMeta(code)]);
  const locations = (meta?.locations ?? []).map((l) => ({ id: l.id, name: l.name }));

  return (
    <>
      <PageHeader title="Custody" description="Check items in when they arrive, move them between locations, and record claims and disposals." />
      <form method="get" className="row" role="search" aria-label="Find an item" style={{ alignItems: 'flex-end' }}>
        <TextInput
          id="custody-find"
          label="Find by item ID"
          fieldClassName="inline-field"
          className="mono"
          name="find"
          defaultValue={find}
          placeholder={`${code}-W-000123`}
          autoComplete="off"
        />
        <Button type="submit" icon={<IconSearch />}>
          Find
        </Button>
      </form>
      {findError ? (
        <Notice tone="warning" live="assertive">
          {findError}
        </Notice>
      ) : null}
      {loaded.ok ? (
        <>
          {loaded.data.fallback ? (
            <Notice>Showing published items only. Unpublished items at the office are reachable from the queue or by ID.</Notice>
          ) : null}
          <CustodyBoard
            code={code}
            lists={loaded.data.lists}
            locations={locations}
            tz={meta?.timezone ?? null}
            can={{
              receive: canPerform(ctx.role, 'item.receive'),
              transfer: canPerform(ctx.role, 'item.transfer'),
              claim: canPerform(ctx.role, 'item.claim'),
              dispose: canPerform(ctx.role, 'item.dispose'),
              bulkDispose: canPerform(ctx.role, 'item.bulk_dispose'),
            }}
          />
        </>
      ) : (
        <ErrorNotice code={loaded.code} what="Custody lists" signinHref={signinPath(path)} />
      )}
    </>
  );
}
