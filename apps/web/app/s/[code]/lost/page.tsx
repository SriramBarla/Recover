// /s/[code]/lost: file a lost report (§5.2 step 5; 12 §12.4).
import Link from 'next/link';
import { LostReportForm } from '@/components/student/LostReportForm.tsx';
import { todayIn } from '@/components/student/format.ts';
import { metaForPage, titleFor } from '@/components/student/server.ts';
import { Notice } from '@/components/ui/notice.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { toPublicMeta } from '@/lib/storage-url.ts';

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Report a lost item');
}

export default async function LostPage({ params }: Props) {
  const meta = toPublicMeta(await metaForPage((await params).code));
  const code = meta.school.code;
  return (
    <div className="container-narrow stack-lg" style={{ padding: 0 }}>
      <PageHeader
        title="Report a lost item"
        description={
          <>
            First, <Link href={`/s/${code}/search`} prefetch={false}>search the found items</Link>. If it is not there yet, tell us
            what you lost and we will show you matches on this browser when a matching item is posted.
          </>
        }
      />
      {meta.school.flags.lostReports ? (
        <LostReportForm meta={meta} today={todayIn(meta.school.timezone)} />
      ) : (
        <Notice tone="warning">Lost reports are turned off at this school. Please ask at the front office.</Notice>
      )}
    </div>
  );
}
