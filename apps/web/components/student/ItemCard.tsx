// Feed/search thumbnail card. No hooks, so both Server Components and the client "Load more" list use it.
// Links do not prefetch: a grid of 30 listings must not become 30 origin renders during dismissal peaks.
import Link from 'next/link';
import type { PublicItem } from '@recover/shared/dto.ts';
import { categoryLabel, custodyLine, photoAlt } from './format.ts';

export function ItemCard({
  item,
  href,
  locationName,
  foundLabel,
  eager = false,
  extra,
}: {
  item: PublicItem;
  href: string;
  locationName: string | null;
  foundLabel: string;
  eager?: boolean;
  extra?: string;
}) {
  const photo = item.photos[0];
  return (
    <Link href={href} prefetch={false} className="card-link">
      <article className="card item-card">
        {photo ? (
          <img
            className="thumb"
            src={photo.thumbUrl}
            alt={photoAlt(item.category)}
            width={400}
            height={400}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : (
          <div className="thumb" aria-hidden="true" />
        )}
        <div className="body">
          <p className="desc">{item.description}</p>
          <p className="small muted">
            {categoryLabel(item.category)}
            {foundLabel ? ` · Found ${foundLabel}` : ''}
          </p>
          <p className="small">{extra ?? custodyLine(item.custody, locationName)}</p>
        </div>
      </article>
    </Link>
  );
}
