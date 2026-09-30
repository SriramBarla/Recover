// /staff/[code]/post and ?mode=backfill: trusted staff posting (G-08; §5.3.2) and the onboarding
// backfill of the current shelf (§24 step 5).
import type { Metadata } from 'next';
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
      <div className="spread">
        <div className="stack">
          <h1>{mode === 'backfill' ? 'Backfill the shelf' : 'Post a found item'}</h1>
          <p className="muted">
            {mode === 'backfill'
              ? 'Photograph what is already in the lost and found. Items are posted as checked in at the location you pick once for this session.'
              : 'Staff posts skip the review queue but still go through photo processing and screening before they are public.'}
          </p>
        </div>
        <nav className="nav" aria-label="Posting mode">
          <a href={`/staff/${code}/post`} aria-current={mode === 'staff' ? 'page' : undefined}>
            Single item
          </a>
          <a href={`/staff/${code}/post?mode=backfill`} aria-current={mode === 'backfill' ? 'page' : undefined}>
            Backfill
          </a>
        </nav>
      </div>
      {meta === null ? <div className="notice notice-warn">School details could not be loaded; locations and the map may be missing.</div> : null}
      {meta !== null && meta.locations.length === 0 ? (
        <div className="notice notice-warn">This school has no active locations yet. A school admin can add them under Locations.</div>
      ) : null}
      <PostForm key={mode} code={code} mode={mode} meta={meta} />
    </>
  );
}
