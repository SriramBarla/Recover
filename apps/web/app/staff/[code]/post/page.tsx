// /staff/[code]/post and ?mode=backfill: trusted staff posting (G-08; §5.3.2) and the onboarding
// backfill of the current shelf (§24 step 5).
import type { Metadata } from 'next';
import { IconList, IconPlus } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { SubNav } from '@/components/ui/sub-nav.tsx';
import { PostForm } from '@/components/staff/PostForm.tsx';
import { requireStaff, schoolMeta } from '@/lib/staff.ts';

export const metadata: Metadata = { title: 'Post an item - Recover' };

export default async function PostPage({ params, searchParams }: PageProps<'/staff/[code]/post'>) {
  const { code } = await params;
  const sp = await searchParams;
  const mode = sp.mode === 'backfill' ? 'backfill' : 'staff';
  await requireStaff(code, { path: `/staff/${code}/post${mode === 'backfill' ? '?mode=backfill' : ''}` });
  const meta = await schoolMeta(code);

  return (
    <>
      <PageHeader
        title={mode === 'backfill' ? 'Backfill the shelf' : 'Post a found item'}
        description={
          mode === 'backfill'
            ? 'Photograph what is already in the lost and found. Items are posted as checked in at the location you pick once for this session.'
            : 'Staff posts skip the review queue but still go through photo processing and screening before they are public.'
        }
      >
        <SubNav
          label="Posting mode"
          current={mode === 'backfill' ? `/staff/${code}/post?mode=backfill` : `/staff/${code}/post`}
          items={[
            { href: `/staff/${code}/post`, label: 'Single item', icon: <IconPlus /> },
            { href: `/staff/${code}/post?mode=backfill`, label: 'Backfill', icon: <IconList /> },
          ]}
        />
      </PageHeader>
      {meta === null ? <Notice tone="warning">School details could not be loaded; locations and the map may be missing.</Notice> : null}
      {meta !== null && meta.locations.length === 0 ? (
        <Notice tone="warning">This school has no active locations yet. A school admin can add them under Locations.</Notice>
      ) : null}
      <PostForm key={mode} code={code} mode={mode} meta={meta} />
    </>
  );
}
