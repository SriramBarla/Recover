// /s/[code]: search, "Found something", "I lost something", this browser's lost reports, and the feed
// with location/category/date filters (§5.2; 04 screen inventory; 12 §12.3 badge).
import Link from 'next/link';
import type { Category, Meta, MyLostReport } from '@recover/shared/dto.ts';
import { ItemCard } from '@/components/student/ItemCard.tsx';
import { LoadMore } from '@/components/student/LoadMore.tsx';
import { CATEGORY_LABELS, formatDay } from '@/components/student/format.ts';
import {
  deviceDigest,
  firstParam,
  locationNames,
  metaForPage,
  titleFor,
  type SearchParams,
} from '@/components/student/server.ts';
import { getFeed, type FeedFilters } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { encodeCursor, isCategory, srcValue } from '@/lib/http.ts';
import { toPublicItem } from '@/lib/storage-url.ts';

type Props = { params: Promise<{ code: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Lost and found');
}

const SINCE_DAYS: Record<string, number> = { '7': 7, '30': 30 };

function filtersFrom(sp: SearchParams, meta: Meta) {
  const location = firstParam(sp.location) ?? '';
  const category = firstParam(sp.category) ?? '';
  const since = firstParam(sp.since) ?? '';
  const days = SINCE_DAYS[since];
  const feed: FeedFilters = {
    cursor: null,
    locationId: meta.locations.some((l) => l.id === location) ? location : null,
    category: isCategory(category) ? category : null,
    since: days ? new Date(Date.now() - days * 86_400_000).toISOString() : null,
  };
  return { feed, form: { location: feed.locationId ?? '', category: feed.category ?? '', since: days ? since : '' } };
}

function hasNewMatch(r: MyLostReport): boolean {
  if (!r.matches?.length || !r.lastMatchedAt) return false;
  return !r.lastViewedAt || Date.parse(r.lastMatchedAt) > Date.parse(r.lastViewedAt);
}

export default async function SchoolHome({ params, searchParams }: Props) {
  const { code: rawCode } = await params;
  const sp = await searchParams;
  const meta = await metaForPage(rawCode);
  const { school } = meta;
  const code = school.code;
  const tz = school.timezone;
  const { feed, form } = filtersFrom(sp, meta);
  const filtered = Boolean(feed.locationId || feed.category || feed.since);

  const digest = await deviceDigest(school.id);
  // The lost-reports card is secondary: if that read fails the feed still renders.
  const reportsRead: Promise<MyLostReport[]> = digest
    ? api<{ reports: MyLostReport[] }>('api_my_lost_reports', { p_school_code: code, p_device_digest: digest })
        .then((r) => r.reports ?? [])
        .catch(() => [])
    : Promise.resolve([]);
  const [page, reports] = await Promise.all([getFeed(meta, feed), reportsRead]);
  const items = page.items.map(toPublicItem);
  const names = locationNames(meta);
  const src = srcValue(firstParam(sp.src));
  const newMatches = reports.filter(hasNewMatch).length;
  const nextCursor = encodeCursor(page.nextCursor);
  const moreQuery = new URLSearchParams();
  if (feed.locationId) moreQuery.set('location', feed.locationId);
  if (feed.category) moreQuery.set('category', feed.category);
  if (feed.since) moreQuery.set('since', feed.since);
  const categories = Object.keys(CATEGORY_LABELS) as Category[];

  return (
    <div className="stack-lg">
      <h1>Lost and found</h1>

      <form role="search" action={`/s/${code}/search`} method="get" className="row">
        <label htmlFor="home-q" className="visually-hidden">
          Search found items
        </label>
        <input
          id="home-q"
          name="q"
          type="search"
          className="input"
          style={{ flex: '1 1 14rem', width: 'auto' }}
          placeholder="Search, like: blue water bottle"
          maxLength={120}
          required
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      <div className="grid-wide">
        <Link className="btn btn-primary btn-lg btn-block" href={`/s/${code}/found${src ? `?src=${src}` : ''}`} prefetch={false}>
          Found something
        </Link>
        <Link className="btn btn-lg btn-block" href={`/s/${code}/lost`} prefetch={false}>
          I lost something
        </Link>
      </div>

      {reports.length > 0 && (
        <Link className="card-link" href={`/s/${code}/lost/mine`} prefetch={false}>
          <div className="card spread">
            <strong>Your lost reports</strong>
            <span className="chips">
              <span className="badge">{reports.length} open</span>
              {newMatches > 0 && (
                <span className="badge badge-warn">
                  {newMatches === 1 ? 'New match' : `${newMatches} with new matches`}
                </span>
              )}
            </span>
          </div>
        </Link>
      )}

      <section aria-labelledby="feed-heading" className="stack">
        <h2 id="feed-heading">Found items</h2>
        <form method="get" action={`/s/${code}`} className="row" aria-label="Filter found items">
          <div className="field">
            <label className="label" htmlFor="f-location">
              Pickup location
            </label>
            <select id="f-location" name="location" className="select" defaultValue={form.location}>
              <option value="">All locations</option>
              {meta.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="f-category">
              Category
            </label>
            <select id="f-category" name="category" className="select" defaultValue={form.category}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="f-since">
              Found
            </label>
            <select id="f-since" name="since" className="select" defaultValue={form.since}>
              <option value="">Any time</option>
              <option value="7">In the last 7 days</option>
              <option value="30">In the last 30 days</option>
            </select>
          </div>
          <div className="row" style={{ alignSelf: 'flex-end' }}>
            <button type="submit" className="btn">
              Apply filters
            </button>
            {filtered && (
              <Link href={`/s/${code}`} prefetch={false}>
                Clear filters
              </Link>
            )}
          </div>
        </form>

        {items.length === 0 ? (
          <div className="notice">
            {filtered ? (
              <p>No found items match these filters.</p>
            ) : (
              <p>No found items are posted right now. Check back later.</p>
            )}
            <p>
              Lost something? <Link href={`/s/${code}/lost`} prefetch={false}>Report what you lost</Link> and we will show you
              matches here.
            </p>
          </div>
        ) : (
          <ul className="grid" aria-label="Found items" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {items.map((item, i) => (
              <li key={item.id}>
                <ItemCard
                  item={item}
                  href={`/s/${code}/items/${item.publicId}`}
                  locationName={names[item.locationId] ?? null}
                  foundLabel={formatDay(item.foundAt, tz)}
                  eager={i < 6}
                />
              </li>
            ))}
          </ul>
        )}
        {nextCursor && (
          <LoadMore code={code} cursor={nextCursor} query={moreQuery.toString()} locationNames={names} timeZone={tz} />
        )}
      </section>
    </div>
  );
}
