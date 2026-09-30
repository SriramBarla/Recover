// /staff/forbidden: the staff app's 403 page (no membership at this school, or role too low).
import type { Metadata } from 'next';
import { ROLE_LABELS } from '@/components/staff/format.ts';
import { signOutAction } from '@/components/staff/actions.ts';
import { Button, buttonClass } from '@/components/ui/button.tsx';
import { IconArrowLeft, IconLogOut } from '@/components/ui/icons.tsx';
import { Logo } from '@/components/ui/logo.tsx';
import { Notice } from '@/components/ui/notice.tsx';

export const metadata: Metadata = { title: 'No access - Recover' };

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export default async function Forbidden({ searchParams }: PageProps<'/staff/forbidden'>) {
  const sp = await searchParams;
  const school = one(sp.school);
  const need = one(sp.need);
  const district = one(sp.district) === '1';
  const code = school && /^[A-Z]{2,6}$/.test(school) ? school : null;
  const role = need && need in ROLE_LABELS ? ROLE_LABELS[need as keyof typeof ROLE_LABELS] : null;

  return (
    <main id="main" className="container-narrow stack-lg" style={{ paddingTop: '3rem' }}>
      <Logo size={36} />
      <h1>You do not have access</h1>
      <Notice tone="danger" live="assertive">
        {district
          ? 'District administration is limited to district admins.'
          : role && code
            ? `This page at ${code} needs the ${role} role or higher.`
            : code
              ? `Your account is not a member of ${code}.`
              : 'Your account cannot open this page.'}
      </Notice>
      <p className="muted">If you think this is wrong, ask your school admin to check the roster.</p>
      <div className="button-row">
        <a className={buttonClass({ variant: 'primary' })} href={code && role ? `/staff/${code}/queue` : '/staff'}>
          <IconArrowLeft />
          {code && role ? 'Back to the queue' : 'Choose a school'}
        </a>
        <form action={signOutAction}>
          <Button type="submit" icon={<IconLogOut />}>
            Sign in with a different account
          </Button>
        </form>
      </div>
    </main>
  );
}
