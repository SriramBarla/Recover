'use client';
// Feed pagination: appends the next cursor page from GET /api/s/[code]/items (§5.2; 08 cursor on
// (created_at, id)). Focus moves to the first new card so keyboard users continue where they were.
import { useEffect, useRef, useState } from 'react';
import type { PublicItem } from '@recover/shared/dto.ts';
import { Button } from '@/components/ui/button.tsx';
import { IconChevronDown } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { ItemCard } from './ItemCard.tsx';
import { apiFetch } from './client-api.ts';
import { formatDay } from './format.ts';

export function LoadMore({
  code,
  cursor,
  query,
  locationNames,
  timeZone,
}: {
  code: string;
  cursor: string;
  query: string;
  locationNames: Record<string, string>;
  timeZone: string;
}) {
  const [items, setItems] = useState<PublicItem[]>([]);
  const [next, setNext] = useState<string | null>(cursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const focusIndex = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const i = focusIndex.current;
    if (i === null) return;
    focusIndex.current = null;
    listRef.current?.querySelectorAll('a')[i]?.focus();
  }, [items]);

  async function load() {
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    const params = new URLSearchParams(query);
    params.set('cursor', next);
    const r = await apiFetch<{ items: PublicItem[]; nextCursor: string | null }>(`/api/s/${code}/items?${params}`);
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    focusIndex.current = r.data.items.length > 0 ? items.length : null;
    setItems((prev) => [...prev, ...r.data.items]);
    setNext(r.data.nextCursor);
    setStatus(r.data.items.length ? `Loaded ${r.data.items.length} more items.` : 'No more items.');
  }

  return (
    <>
      {items.length > 0 && (
        <ul className="item-grid" ref={listRef} aria-label="More found items" style={{ marginTop: '0.75rem' }}>
          {items.map((item) => (
            <li key={item.id}>
              <ItemCard
                item={item}
                href={`/s/${code}/items/${item.publicId}`}
                locationName={locationNames[item.locationId] ?? null}
                foundLabel={formatDay(item.foundAt, timeZone)}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="visually-hidden" aria-live="polite">
        {status}
      </p>
      {error && (
        <Notice tone="danger" live="assertive" style={{ marginTop: '1rem' }}>
          {error}
        </Notice>
      )}
      {next && (
        <Button block onClick={load} disabled={busy} style={{ marginTop: '1rem' }} icon={<IconChevronDown />}>
          {busy ? 'Loading...' : 'Load more'}
        </Button>
      )}
    </>
  );
}
