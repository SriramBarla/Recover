// Landing page: enter the school code from the poster and go to /s/CODE. A plain GET form, so it works
// before (or without) any JavaScript.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { normalizeSchoolCode } from '@/lib/cache.ts';

export const metadata: Metadata = { title: 'Recover - school lost and found' };

export default async function Landing({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = typeof sp.code === 'string' ? sp.code.slice(0, 20) : '';
  const code = raw ? normalizeSchoolCode(raw) : null;
  if (code) redirect(`/s/${code}`);
  const invalid = raw !== '';

  return (
    <main id="main" className="container-narrow stack-lg" style={{ paddingTop: '3rem' }}>
      <header className="stack">
        <p className="brand">Recover</p>
        <h1>School lost and found</h1>
        <p>See what has been found at your school, report something you lost, or post something you found.</p>
      </header>
      <form method="get" action="/" className="card stack">
        <div className="field">
          <label htmlFor="code" className="label">
            School code
          </label>
          <input
            id="code"
            name="code"
            className="input"
            defaultValue={raw}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            required
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? 'code-hint code-error' : 'code-hint'}
          />
          <p id="code-hint" className="hint">
            It is on the Recover posters at your school, for example FCHS.
          </p>
          {invalid && (
            <p id="code-error" className="field-error" role="alert">
              A school code is 2 to 6 letters.
            </p>
          )}
        </div>
        <button type="submit" className="btn btn-primary btn-lg">
          Go to my school
        </button>
      </form>
      <p className="small muted">
        School staff: <a href="/staff">sign in here</a>.
      </p>
    </main>
  );
}
