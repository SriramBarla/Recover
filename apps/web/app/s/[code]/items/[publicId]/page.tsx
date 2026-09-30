// /s/[code]/items/[publicId]: the public listing (§5.2 steps 3-4). Medium photos, description, zone name only
// (never the finder's pin or note), found time, custody line, item ID, location hours, and how to claim in
// person. There is no online claim step.
import { notFound } from 'next/navigation';
import type { ListingRow } from '@recover/shared/dto.ts';
import { categoryLabel, custodyLine, formatDateTime, photoAlt } from '@/components/student/format.ts';
import { isNotFound, metaForPage, titleFor } from '@/components/student/server.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Card } from '@/components/ui/card.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { IconBuilding, IconClock, IconMapPin, IconShieldCheck } from '@/components/ui/icons.tsx';
import { KeyValue } from '@/components/ui/key-value.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { getListing, normalizePublicId } from '@/lib/cache.ts';
import { toListing } from '@/lib/storage-url.ts';

type Props = { params: Promise<{ code: string; publicId: string }> };

export async function generateMetadata({ params }: Props) {
  const { code, publicId } = await params;
  return titleFor(code, `Found item ${normalizePublicId(publicId) ?? ''}`.trim());
}

function scaled(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const k = Math.min(1, 1200 / Math.max(width, height));
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

export default async function ListingPage({ params }: Props) {
  const { code: rawCode, publicId: rawId } = await params;
  const meta = await metaForPage(rawCode);
  const publicId = normalizePublicId(rawId);
  if (!publicId) notFound();
  let row: ListingRow;
  try {
    row = await getListing(meta, publicId);
  } catch (e) {
    if (isNotFound(e)) notFound();
    throw e;
  }
  const item = toListing(row);
  const code = meta.school.code;
  const tz = meta.school.timezone;
  const where = item.location.name;

  const atOffice = item.custody === 'at_location';

  return (
    <article className="stack-lg container-narrow" style={{ padding: 0 }}>
      <PageHeader
        back={{ href: `/s/${code}`, label: 'Back to all found items', prefetch: false }}
        eyebrow={
          <span className="with-icon">
            <CategoryIcon category={item.category} size={16} />
            {categoryLabel(item.category)}
          </span>
        }
        title={item.description}
      >
        <p className="chips" style={{ margin: 0 }}>
          <Badge tone={atOffice ? 'ok' : 'warn'} size="lg" icon={atOffice ? <IconBuilding /> : <IconClock />}>
            {custodyLine(item.custody, where)}
          </Badge>
          {item.zoneName ? (
            <Badge size="lg" icon={<IconMapPin />}>
              Found near {item.zoneName}
            </Badge>
          ) : null}
        </p>
      </PageHeader>

      {item.photos.length > 0 ? (
        <div className="stack">
          {item.photos.map((p, i) => {
            const size = scaled(p.width, p.height);
            return (
              <img
                key={p.position}
                className="listing-photo"
                src={p.mediumUrl}
                alt={item.photos.length > 1 ? `${photoAlt(item.category)} (${i + 1} of ${item.photos.length})` : photoAlt(item.category)}
                width={size?.width}
                height={size?.height}
                loading={i === 0 ? 'eager' : 'lazy'}
                fetchPriority={i === 0 ? 'high' : 'auto'}
                decoding="async"
              />
            );
          })}
        </div>
      ) : (
        <div className="listing-photo listing-photo-empty">
          <CategoryIcon category={item.category} size={48} />
          <p className="muted" style={{ margin: 0 }}>
            No photo for this item.
          </p>
        </div>
      )}

      <Card padding="lg">
        <KeyValue
          items={[
            { label: 'Item ID', value: <span className="mono">{item.publicId}</span> },
            { label: 'Found', value: `${formatDateTime(item.foundAt, tz)}${item.zoneName ? `, near ${item.zoneName}` : ''}` },
            { label: 'Where it is now', value: custodyLine(item.custody, where) },
            { label: 'Hours', value: item.location.hours || 'Ask at the front office.' },
          ]}
        />
      </Card>

      <section className="notice notice-info has-icon" aria-labelledby="claim-heading">
        <IconShieldCheck className="notice-icon" size={22} />
        <div className="notice-body stack-sm">
          <h2 id="claim-heading" style={{ margin: 0 }}>
            How to claim it
          </h2>
          <p>
            Go to {where} in person and give them the item ID <span className="mono">{item.publicId}</span>.
            {item.custody === 'with_finder' ? ' It may still be on its way there, so check the hours and try again later if needed.' : ''}
          </p>
          <p>
            Staff will ask you something only the owner would know, like what is inside it or a mark on it. Photos alone are not
            proof, and there is no online claim.
          </p>
        </div>
      </section>
    </article>
  );
}
