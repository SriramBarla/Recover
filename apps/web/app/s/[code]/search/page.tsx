// /s/[code]/search?q=: results grid for this school (§11), and, when the school has opted in, the optional
// cross-school search (F-79). Same `search` rate limit as the JSON route; query text is never logged.
import Link from 'next/link';
import { headers } from 'next/headers';
import { PublicError } from '@recover/shared/errors.ts';
import type { PublicItemRow } from '@recover/shared/dto.ts';
import { cleanText } from '@recover/shared/unicode.ts';
import { ItemCard } from '@/components/student/ItemCard.tsx';
import { formatDay } from '@/components/student/format.ts';
import { deviceDigest, firstParam, locationNames, metaForPage, titleFor, type SearchParams } from '@/components/student/server.ts';
import { retryHint } from '@/components/student/client-api.ts';
import { searchQueryHmac } from '@/lib/cache.ts';
import { api } from '@/lib/db.ts';
import { take } from '@/lib/ratelimit.ts';
import { toCrossSchoolItem, toPublicItem, type CrossSchoolItem } from '@/lib/storage-url.ts';

type Props = { params: Promise<{ code: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Search');
}

export default async function SearchPage({ params, searchParams }: Props) {
  const meta = await metaForPage((await params).code);
  const sp = await searchParams;
  const code = meta.school.code;
  const tz = meta.school.timezone;
  const names = locationNames(meta);
  const raw = (firstParam(sp.q) ?? '').slice(0, 200);
  const crossAllowed = meta.school.flags.crossSchoolSearch;
  const all = crossAllowed && firstParam(sp.all) === '1';

  let results: CrossSchoolItem[] | null = null;
  let problem: string | null = null;
  if (raw.trim()) {
    try {
      const digest = await deviceDigest(meta.school.id);
      await take(code, all ? 'search_all' : 'search', digest, { headers: await headers() });
      const q = cleanText(raw, { field: 'q', min: 1, max: 120 });
      const hmac = searchQueryHmac(q);
      if (all) {
        const res = await api<{ items: (PublicItemRow & { schoolCode: string })[] }>('api_search_all', {
          p_from_code: code,
          p_q: q,
          p_query_hmac: hmac,
        });
        results = res.items.map(toCrossSchoolItem);
      } else {
        const res = await api<{ items: PublicItemRow[] }>('api_search', {
          p_school_code: code,
          p_q: q,
          p_location_id: null,
          p_category: null,
          p_query_hmac: hmac,
        });
        results = res.items.map((r) => ({ ...toPublicItem(r), schoolCode: code }));
      }
    } catch (e) {
      if (!(e instanceof PublicError) || e.status >= 500) throw e;
      problem =
        e.code === 'invalid_input'
          ? 'Please use up to 120 letters, numbers and spaces.'
          : `${e.message}${retryHint({ code: e.code, message: e.message, retryAfterS: e.retryAfterS, status: e.status })}`;
    }
  }

  return (
    <div className="stack-lg">
      <h1>Search found items</h1>
      <form role="search" method="get" action={`/s/${code}/search`} className="stack">
        <div className="row">
          <label htmlFor="search-q" className="visually-hidden">
            Search found items
          </label>
          <input
            id="search-q"
            name="q"
            type="search"
            className="input"
            style={{ flex: '1 1 14rem', width: 'auto' }}
            defaultValue={raw}
            placeholder="Like: black hoodie, calculator, airpods"
            maxLength={120}
            required
          />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </div>
        {crossAllowed && (
          <label className="row small">
            <input type="checkbox" name="all" value="1" defaultChecked={all} style={{ width: '1.25rem', height: '1.25rem' }} />
            Include other schools in the district
          </label>
        )}
      </form>

      {problem && (
        <p className="notice notice-warn" role="alert">
          {problem}
        </p>
      )}

      {results && (
        <section aria-labelledby="results-heading" className="stack">
          <h2 id="results-heading" aria-live="polite">
            {results.length === 0 ? 'No matches' : `${results.length} ${results.length === 1 ? 'match' : 'matches'}`}
          </h2>
          {results.length === 0 ? (
            <div className="notice stack">
              <p>Nothing matches that yet. Try other words, like the color, brand, or what it is.</p>
              <p>
                <Link className="btn btn-primary" href={`/s/${code}/lost`} prefetch={false}>
                  Report what you lost
                </Link>
              </p>
              <p className="small">We will show you new matches on this browser when a matching item is posted.</p>
            </div>
          ) : (
            <ul className="grid" aria-label="Search results" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {results.map((item, i) => {
                const here = item.schoolCode === code;
                return (
                  <li key={`${item.schoolCode}:${item.id}`}>
                    <ItemCard
                      item={item}
                      href={`/s/${item.schoolCode}/items/${item.publicId}`}
                      locationName={here ? (names[item.locationId] ?? null) : null}
                      foundLabel={formatDay(item.foundAt, tz)}
                      eager={i < 6}
                      extra={here ? undefined : `At another school (${item.schoolCode})`}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
