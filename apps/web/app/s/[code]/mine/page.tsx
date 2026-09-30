// /s/[code]/mine: items this browser posted, with plain-language status (G-32). No moderation detail.
import type { MyItem } from '@recover/shared/dto.ts';
import { categoryLabel, formatDay, myItemStatus, type Tone } from '@/components/student/format.ts';
import { deviceDigest, metaForPage, titleFor } from '@/components/student/server.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { LinkButton } from '@/components/ui/button.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { IconAlert, IconCamera, IconCheck, IconChevronRight, IconClock, IconX } from '@/components/ui/icons.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { api } from '@/lib/db.ts';

// Status is always an icon plus words (Appendix H), matched to the tone.
function StatusIcon({ tone }: { tone: Tone }) {
  if (tone === 'ok') return <IconCheck />;
  if (tone === 'danger') return <IconAlert />;
  if (tone === 'neutral') return <IconX />;
  return <IconClock />;
}

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Your posts');
}

export default async function MyItemsPage({ params }: Props) {
  const meta = await metaForPage((await params).code);
  const code = meta.school.code;
  const digest = await deviceDigest(meta.school.id);
  const items = digest
    ? (await api<{ items: MyItem[] }>('api_my_items', { p_school_code: code, p_device_digest: digest })).items
    : [];

  return (
    <div className="container-narrow stack-lg" style={{ padding: 0 }}>
      <PageHeader title="Your posts" description="Found items posted from this browser." />
      {items.length === 0 ? (
        <EmptyState
          title="You have not posted anything from this browser."
          icon={<IconCamera />}
          actions={
            <LinkButton variant="primary" href={`/s/${code}/found`} prefetch={false} icon={<IconCamera />}>
              Report something you found
            </LinkButton>
          }
        />
      ) : (
        <ul className="item-list">
          {items.map((i) => {
            const status = myItemStatus(i);
            const visible =
              i.publicId && i.reviewStatus === 'approved' && i.publicationStatus === 'published' &&
              (i.custody === 'with_finder' || i.custody === 'at_location');
            return (
              <li key={i.itemId} className="card stack-sm">
                <div className="spread">
                  <strong className="with-icon">
                    <CategoryIcon category={i.category} />
                    {categoryLabel(i.category)}
                  </strong>
                  <Badge tone={status.tone} icon={<StatusIcon tone={status.tone} />}>
                    {status.text}
                  </Badge>
                </div>
                <p className="small muted" style={{ margin: 0 }}>
                  Posted {formatDay(i.createdAt, meta.school.timezone)}
                  {i.publicId ? (
                    <>
                      {' '}
                      · Item ID <span className="mono">{i.publicId}</span>
                    </>
                  ) : null}
                </p>
                {visible && (
                  <p style={{ margin: 0 }}>
                    <LinkButton size="sm" variant="ghost" href={`/s/${code}/items/${i.publicId}`} prefetch={false} iconEnd={<IconChevronRight />}>
                      View listing
                    </LinkButton>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
