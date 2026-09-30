// Student shell for one school: header with the school name, navigation, main landmark (the root layout's
// skip link targets #main), footer, and the service worker registration.
// connection() forces request-time rendering: the proxy's CSP nonce only reaches dynamically rendered
// HTML, so no student page may be prerendered or cached as HTML.
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import type { Meta } from '@recover/shared/dto.ts';
import { ClientRuntime } from '@/components/student/ClientRuntime.tsx';
import { IconHome, IconSearch, IconTag } from '@/components/ui/icons.tsx';
import { TopNav } from '@/components/ui/top-nav.tsx';
import { getMeta } from '@/lib/cache.ts';

export default async function SchoolLayout({ children, params }: { children: ReactNode; params: Promise<{ code: string }> }) {
  await connection();
  const { code } = await params;
  // The layout never throws: an unknown school or an outage is rendered by the page's not-found/error UI
  // inside this shell.
  let meta: Meta | null = null;
  try {
    meta = await getMeta(code);
  } catch {
    meta = null;
  }
  const school = meta?.school.code;
  return (
    <>
      <TopNav
        homeHref={school ? `/s/${school}` : '/'}
        brandContext={meta ? meta.school.name : null}
        navLabel="Recover"
        prefetch={false}
        items={
          school
            ? [
                { href: `/s/${school}`, label: 'Found items', icon: <IconHome />, match: 'exact' },
                { href: `/s/${school}/lost/mine`, label: 'Your reports', icon: <IconSearch /> },
                { href: `/s/${school}/mine`, label: 'Your posts', icon: <IconTag /> },
              ]
            : []
        }
      />
      <main id="main" className="container">
        {children}
      </main>
      <footer className="footer">
        <p>Recover school lost and found. Questions? Ask at the front office.</p>
      </footer>
      <ClientRuntime />
    </>
  );
}
