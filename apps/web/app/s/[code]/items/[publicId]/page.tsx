// /s/[code]/items/[publicId]: the public listing (§5.2 steps 3-4). Medium photos, description, zone name only
// (never the finder's pin or note), found time, custody line, item ID, location hours, and how to claim in
// person. There is no online claim step.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ListingRow } from '@recover/shared/dto.ts';
import { categoryLabel, custodyLine, formatDateTime, photoAlt } from '@/components/student/format.ts';
import { isNotFound, metaForPage, titleFor } from '@/components/student/server.ts';
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

  return (
    <article className="stack-lg container-narrow" style={{ padding: 0 }}>
      <p>
        <Link href={`/s/${code}`} prefetch={false}>
          Back to all found items
        </Link>
      </p>
      <header className="stack">
        <h1>{item.description}</h1>
        <p className="chips">
          <span className="badge">{categoryLabel(item.category)}</span>
          <span className={item.custody === 'at_location' ? 'badge badge-ok' : 'badge badge-brand'}>
            {custodyLine(item.custody, where)}
          </span>
        </p>
      </header>

      {item.photos.length > 0 ? (
        <div className="stack">
          {item.photos.map((p, i) => {
            const size = scaled(p.width, p.height);
            return (
              <img
                key={p.position}
                src={p.mediumUrl}
                alt={item.photos.length > 1 ? `${photoAlt(item.category)} (${i + 1} of ${item.photos.length})` : photoAlt(item.category)}
                width={size?.width}
                height={size?.height}
                loading={i === 0 ? 'eager' : 'lazy'}
                fetchPriority={i === 0 ? 'high' : 'auto'}
                decoding="async"
                style={{ borderRadius: 'var(--radius)', background: 'var(--surface-2)' }}
              />
            );
          })}
        </div>
      ) : (
        <p className="muted">No photo for this item.</p>
      )}

      <dl className="card stack" style={{ margin: 0 }}>
        <div>
          <dt className="label">Item ID</dt>
          <dd className="mono" style={{ margin: 0 }}>
            {item.publicId}
          </dd>
        </div>
        <div>
          <dt className="label">Found</dt>
          <dd style={{ margin: 0 }}>
            {formatDateTime(item.foundAt, tz)}
            {item.zoneName ? `, near ${item.zoneName}` : ''}
          </dd>
        </div>
        <div>
          <dt className="label">Where it is now</dt>
          <dd style={{ margin: 0 }}>{custodyLine(item.custody, where)}</dd>
        </div>
        <div>
          <dt className="label">Hours</dt>
          <dd style={{ margin: 0 }}>{item.location.hours || 'Ask at the front office.'}</dd>
        </div>
      </dl>

      <section className="notice stack" aria-labelledby="claim-heading">
        <h2 id="claim-heading">How to claim it</h2>
        <p>
          Go to {where} in person and give them the item ID <span className="mono">{item.publicId}</span>.
          {item.custody === 'with_finder' ? ' It may still be on its way there, so check the hours and try again later if needed.' : ''}
        </p>
        <p>
          Staff will ask you something only the owner would know, like what is inside it or a mark on it. Photos alone are not
          proof, and there is no online claim.
        </p>
      </section>
    </article>
  );
}
