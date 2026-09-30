// /s/[code]/found: the found-item wizard (§5.1). The server passes the public meta (map, zones, locations,
// categories) and the allowlisted QR campaign code (F-99); the wizard runs in the browser.
import { FoundWizard } from '@/components/student/FoundWizard.tsx';
import { firstParam, metaForPage, titleFor, type SearchParams } from '@/components/student/server.ts';
import { srcValue } from '@/lib/http.ts';
import { toPublicMeta } from '@/lib/storage-url.ts';

type Props = { params: Promise<{ code: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props) {
  return titleFor((await params).code, 'Report a found item');
}

export default async function FoundPage({ params, searchParams }: Props) {
  const meta = toPublicMeta(await metaForPage((await params).code));
  const src = srcValue(firstParam((await searchParams).src));
  if (!meta.school.flags.studentPosting) {
    return (
      <div className="container-narrow stack" style={{ padding: 0 }}>
        <h1>Report a found item</h1>
        <p className="notice">Posting found items online is turned off at this school right now. Please take what you found to the office.</p>
        <ul className="stack">
          {meta.locations.map((l) => (
            <li key={l.id}>
              <strong>{l.name}</strong>
              {l.hours ? `: ${l.hours}` : ''}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return <FoundWizard meta={meta} src={src} />;
}
