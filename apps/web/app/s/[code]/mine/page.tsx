// /s/[code]/mine: items this browser posted, with plain-language status (G-32). No moderation detail.
import Link from 'next/link';
import type { MyItem } from '@recover/shared/dto.ts';
import { badgeClass, categoryLabel, formatDay, myItemStatus } from '@/components/student/format.ts';
import { deviceDigest, metaForPage, titleFor } from '@/components/student/server.ts';
import { api } from '@/lib/db.ts';

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Your posts');
}

export default async function MyItemsPage({ params }: Props) {
  const meta = await metaForPage((await params).code);
  const code = meta.school.code;
  const digest = await deviceDigest(meta.school);
  const items = digest
    ? (await api<{ items: MyItem[] }>('api_my_items', { p_school_code: code, p_device_digest: digest })).items
    : [];

  return (
    <div className="container-narrow stack-lg" style={{ padding: 0 }}>
      <h1>Your posts</h1>
      <p className="hint">Found items posted from this browser.</p>
      {items.length === 0 ? (
        <div className="notice stack">
          <p>You have not posted anything from this browser.</p>
          <p>
            <Link className="btn btn-primary" href={`/s/${code}/found`} prefetch={false}>
              Report something you found
            </Link>
          </p>
        </div>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((i) => {
            const status = myItemStatus(i);
            const visible =
              i.publicId && i.reviewStatus === 'approved' && i.publicationStatus === 'published' &&
              (i.custody === 'with_finder' || i.custody === 'at_location');
            return (
              <li key={i.itemId} className="card stack">
                <div className="spread">
                  <strong>{categoryLabel(i.category)}</strong>
                  <span className={badgeClass(status.tone)}>{status.text}</span>
                </div>
                <p className="small muted">
                  Posted {formatDay(i.createdAt, meta.school.timezone)}
                  {i.publicId ? (
                    <>
                      {' '}
                      · Item ID <span className="mono">{i.publicId}</span>
                    </>
                  ) : null}
                </p>
                {visible && (
                  <Link href={`/s/${code}/items/${i.publicId}`} prefetch={false}>
                    View listing
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
