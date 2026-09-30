// /s/[code]: search, "Found something", "I lost something", this browser's lost reports, and the feed
// with location/category/date filters (§5.2; 04 screen inventory; 12 §12.3 badge).
import Link from 'next/link';
import type { Category, Meta, MyLostReport } from '@recover/shared/dto.ts';
import { ItemCard } from '@/components/student/ItemCard.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button, LinkButton } from '@/components/ui/button.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { IconBell, IconCamera, IconChevronDown, IconChevronRight, IconSearch, IconSliders } from '@/components/ui/icons.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { Select } from '@/components/ui/select.tsx';
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

  // The lost-reports card is secondary: if that read fails the feed still renders. The digest is part of the
  // read, because during a device-key rotation window resolving it moves the browser's rows (lib/device.ts).
  const reportsRead: Promise<MyLostReport[]> = deviceDigest(school)
    .then((digest) =>
      digest
        ? api<{ reports: MyLostReport[] }>('api_my_lost_reports', { p_school_code: code, p_device_digest: digest })
            .then((r) => r.reports ?? [])
        : [],
    )
    .catch(() => []);
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
      <PageHeader title="Lost and found" description={`Things found at ${school.name}. Staff check every post before it shows here.`} />

      <form role="search" action={`/s/${code}/search`} method="get" className="search-bar">
        <label htmlFor="home-q" className="visually-hidden">
          Search found items
        </label>
        <span className="search-field">
          <IconSearch className="search-icon" />
          <input
            id="home-q"
            name="q"
            type="search"
            className="input"
            placeholder="Search, like: blue water bottle"
            maxLength={120}
            required
          />
        </span>
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      <div className="grid-wide">
        <LinkButton variant="primary" size="lg" block icon={<IconCamera />} href={`/s/${code}/found${src ? `?src=${src}` : ''}`} prefetch={false}>
          Found something
        </LinkButton>
        <LinkButton size="lg" block icon={<IconSearch />} href={`/s/${code}/lost`} prefetch={false}>
          I lost something
        </LinkButton>
      </div>

      {reports.length > 0 && (
        <Link className="card-link" href={`/s/${code}/lost/mine`} prefetch={false}>
          <div className="card spread">
            <span className="with-icon">
              <IconBell />
              <strong>Your lost reports</strong>
            </span>
            <span className="chips">
              <Badge>{reports.length} open</Badge>
              {newMatches > 0 && (
                <Badge tone="accent" icon={<IconBell />}>
                  {newMatches === 1 ? 'New match' : `${newMatches} with new matches`}
                </Badge>
              )}
              <IconChevronRight className="muted" />
            </span>
          </div>
        </Link>
      )}

      <section aria-labelledby="feed-heading" className="stack">
        <h2 id="feed-heading">Found items</h2>
        <details className="filter-panel" open={filtered ? true : undefined}>
          <summary className="btn filter-summary">
            <IconSliders />
            <span>Filter items</span>
            {filtered ? <Badge tone="brand">On</Badge> : null}
            <IconChevronDown className="filter-chevron" />
          </summary>
          <form method="get" action={`/s/${code}`} className="filter-bar" aria-label="Filter found items">
            <Select
              id="f-location"
              name="location"
              label="Pickup location"
              defaultValue={form.location}
              placeholder="All locations"
              options={meta.locations.map((l) => ({ value: l.id, label: l.name }))}
            />
            <Select
              id="f-category"
              name="category"
              label="Category"
              defaultValue={form.category}
              placeholder="All categories"
              options={categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
            />
            <Select
              id="f-since"
              name="since"
              label="Found"
              defaultValue={form.since}
              placeholder="Any time"
              options={[
                { value: '7', label: 'In the last 7 days' },
                { value: '30', label: 'In the last 30 days' },
              ]}
            />
            <div className="button-row filter-actions">
              <Button type="submit" variant="primary">
                Apply filters
              </Button>
              {filtered && (
                <LinkButton variant="ghost" href={`/s/${code}`} prefetch={false}>
                  Clear filters
                </LinkButton>
              )}
            </div>
          </form>
        </details>

        {items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No found items match these filters.' : 'No found items are posted right now.'}
            icon={<IconSearch />}
            actions={
              <LinkButton variant="primary" icon={<IconSearch />} href={`/s/${code}/lost`} prefetch={false}>
                Report what you lost
              </LinkButton>
            }
          >
            {filtered ? 'Try fewer filters. ' : 'Check back later. '}
            Lost something? Report what you lost and we will show you matches here.
          </EmptyState>
        ) : (
          <ul className="item-grid" aria-label="Found items">
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
