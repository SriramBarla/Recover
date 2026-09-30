// /s/[code]/lost: file a lost report (§5.2 step 5; 12 §12.4).
import Link from 'next/link';
import { LostReportForm } from '@/components/student/LostReportForm.tsx';
import { todayIn } from '@/components/student/format.ts';
import { metaForPage, titleFor } from '@/components/student/server.ts';
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
      <h1>Report a lost item</h1>
      <p>
        First, <Link href={`/s/${code}/search`} prefetch={false}>search the found items</Link>. If it is not there yet, tell us what
        you lost and we will show you matches on this browser when a matching item is posted.
      </p>
      {meta.school.flags.lostReports ? (
        <LostReportForm meta={meta} today={todayIn(meta.school.timezone)} />
      ) : (
        <p className="notice">Lost reports are turned off at this school. Please ask at the front office.</p>
      )}
    </div>
  );
}
