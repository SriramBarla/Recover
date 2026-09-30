// ItemCard: one found item in a feed, search results, matches, or staff lists.
// - The thumb is a fixed 1:1 box with explicit width/height, so loading never shifts layout.
// - The description is the link text; the whole card is clickable through a stretched link.
//   Never wrap the card (or any article or landmark) in <a>: Chrome then computes no name for
//   the link. Buttons go in `actions`, which sits above the stretched link.
// - Public data only: zone name (never the exact pin), custody line, public ID.
// Pass `priority` for the first row of a feed (the LCP image) and nowhere else.
import type { Custody } from '@recover/shared/dto.ts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { categoryLabel, CategoryIcon } from './category.tsx';
import { cx } from './cx.ts';
import { IconBuilding, IconCheck, IconClock, IconMapPin } from './icons.tsx';

export type ItemCardPhoto = { url: string; width?: number; height?: number };

export type ItemCardProps = {
  href?: string;
  publicId?: string | null;
  category: string;
  description: string;
  photo?: ItemCardPhoto | null;
  zoneName?: string | null;
  custody: Custody;
  locationName?: string | null;
  // Preformatted by the page in the school's time zone, for example "Found Sep 29".
  foundLabel?: string;
  // Replaces the custody line, for example "At another school (SFHS)" in cross-school results.
  custodyLabel?: string;
  // Extra badges (StatusBadge, "New match").
  status?: ReactNode;
  // Buttons or links of their own ("This is it", "View listing"). They sit above the card link,
  // so they stay separately clickable and the markup stays valid (the link wraps only the title).
  actions?: ReactNode;
  priority?: boolean;
  // Feeds pass false: a grid of 30 cards must not become 30 prefetches during dismissal peaks.
  prefetch?: boolean;
  headingLevel?: 2 | 3 | 4;
  variant?: 'grid' | 'row';
  as?: 'article' | 'li' | 'div';
  className?: string;
};

export function custodyLine(custody: Custody, locationName?: string | null): string {
  const where = locationName && locationName.trim() ? locationName : 'the office';
  switch (custody) {
    case 'with_finder':
      return `Being brought to ${where}`;
    case 'at_location':
      return `At ${where}`;
    case 'claimed':
      return 'Claimed by its owner';
    case 'expired_donated':
      return 'Donated';
    case 'expired_disposed':
      return 'Disposed';
    case 'expired_never_arrived':
      return 'Never arrived';
    default:
      return '';
  }
}

function CustodyIcon({ custody }: { custody: Custody }) {
  if (custody === 'at_location') return <IconBuilding size={16} />;
  if (custody === 'with_finder') return <IconClock size={16} />;
  return <IconCheck size={16} />;
}

export function ItemCard({
  href,
  publicId,
  category,
  description,
  photo,
  zoneName,
  custody,
  locationName,
  foundLabel,
  custodyLabel,
  status,
  actions,
  priority = false,
  prefetch,
  headingLevel = 3,
  variant = 'grid',
  as: Tag = 'div',
  className,
}: ItemCardProps) {
  const H = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const thumbSize = variant === 'row' ? 96 : 400;
  return (
    <Tag className={cx('card', 'item-card', variant === 'row' && 'item-card-row', className)}>
      <div className="item-card-media">
        {photo ? (
          <img
            className="thumb"
            src={photo.url}
            width={thumbSize}
            height={thumbSize}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : undefined}
            decoding="async"
          />
        ) : (
          <div className="thumb item-card-placeholder">
            <CategoryIcon category={category} size={48} />
          </div>
        )}
        <span className="item-card-category">
          <CategoryIcon category={category} size={14} />
          {categoryLabel(category, true)}
        </span>
      </div>
      <div className="body">
        <H className="desc">
          {href ? (
            <Link className="item-card-link" href={href} prefetch={prefetch}>
              {description}
            </Link>
          ) : (
            description
          )}
        </H>
        <ul className="item-card-meta">
          {variant === 'row' ? (
            <li>
              <CategoryIcon category={category} size={16} />
              <span>{categoryLabel(category)}</span>
            </li>
          ) : null}
          {zoneName ? (
            <li>
              <IconMapPin size={16} />
              <span>Found near {zoneName}</span>
            </li>
          ) : null}
          <li className="item-card-custody" data-custody={custody}>
            <CustodyIcon custody={custody} />
            <span>{custodyLabel ?? custodyLine(custody, locationName)}</span>
          </li>
          {foundLabel ? (
            <li>
              <IconClock size={16} />
              <span>{foundLabel}</span>
            </li>
          ) : null}
        </ul>
        {status ? <div className="item-card-status">{status}</div> : null}
        {publicId ? (
          <p className="item-card-id">
            <span className="visually-hidden">Item ID </span>
            {publicId}
          </p>
        ) : null}
        {actions ? <div className="item-card-actions">{actions}</div> : null}
      </div>
    </Tag>
  );
}
