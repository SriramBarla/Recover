// Feed/search thumbnail card. No hooks, so both Server Components and the client "Load more" list use it.
// Links do not prefetch: a grid of 30 listings must not become 30 origin renders during dismissal peaks.
// Presentation is the shared design-system card (fixed-size thumb, category, zone, custody line, ID).
import type { PublicItem } from '@recover/shared/dto.ts';
import { ItemCard as Card } from '@/components/ui/item-card.tsx';

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
  // Replaces the custody line, e.g. "At another school (SFHS)" in cross-school results.
  extra?: string;
}) {
  const photo = item.photos[0];
  return (
    <Card
      href={href}
      prefetch={false}
      publicId={item.publicId}
      category={item.category}
      description={item.description}
      photo={photo ? { url: photo.thumbUrl, width: photo.width, height: photo.height } : null}
      zoneName={item.zoneName}
      custody={item.custody}
      locationName={locationName}
      custodyLabel={extra}
      foundLabel={foundLabel ? `Found ${foundLabel}` : undefined}
      priority={eager}
    />
  );
}
