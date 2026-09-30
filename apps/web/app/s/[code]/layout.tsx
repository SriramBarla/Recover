// Student shell for one school: header with the school name, navigation, main landmark (the root layout's
// skip link targets #main), footer, and the service worker registration.
// connection() forces request-time rendering: the proxy's CSP nonce only reaches dynamically rendered
// HTML, so no student page may be prerendered or cached as HTML.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import type { Meta } from '@recover/shared/dto.ts';
import { ClientRuntime } from '@/components/student/ClientRuntime.tsx';
import { SchoolNav } from '@/components/student/SchoolNav.tsx';
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
  return (
    <>
      <header className="topbar">
        <div className="container">
          <Link className="brand" href={meta ? `/s/${meta.school.code}` : '/'} prefetch={false}>
            {meta ? meta.school.name : 'Recover'}
          </Link>
          {meta && <SchoolNav code={meta.school.code} />}
        </div>
      </header>
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
