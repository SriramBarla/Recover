// /staff/signin: Google sign-in (and the dev-only email login when enabled). Also the Auth.js error
// page, and the step-up destination for destructive actions (G-31: ?reauth=1).
import type { Metadata } from 'next';
import { devSignInAction, googleSignInAction } from '@/components/staff/actions.ts';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconLock, IconShieldCheck, IconUser } from '@/components/ui/icons.tsx';
import { Logo } from '@/components/ui/logo.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { devLoginEnabled } from '@/lib/env.ts';
import { safeReturnPath } from '@/lib/ops.ts';

export const metadata: Metadata = { title: 'Staff sign in - Recover' };

const NOT_SET_UP = "Your account isn't set up for Recover. Ask your school's admin.";

const ERRORS: Record<string, string> = {
  not_set_up: NOT_SET_UP,
  AccessDenied: NOT_SET_UP,
  CredentialsSignin: NOT_SET_UP,
  domain: 'Please sign in with your district Google account.',
  unverified: 'Your Google account email address is not verified.',
  denied: 'That sign-in was not allowed.',
  unavailable: 'Recover could not finish signing you in right now. Please try again in a few minutes.',
  expired: 'Your session ended. Please sign in again.',
  Configuration: 'Sign-in is not configured correctly. Please contact district IT.',
  OAuthSignin: 'Google sign-in could not start. Please try again.',
  OAuthCallbackError: 'Google sign-in was cancelled or failed. Please try again.',
  Callback: 'Google sign-in was cancelled or failed. Please try again.',
  Verification: 'That sign-in link is no longer valid.',
};

function one(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export default async function SignInPage({ searchParams }: PageProps<'/staff/signin'>) {
  const sp = await searchParams;
  const callbackUrl = safeReturnPath(one(sp.callbackUrl), '/staff');
  const errorCode = one(sp.error);
  const error = errorCode ? ERRORS[errorCode] ?? 'Sign-in failed. Please try again.' : null;
  const reauth = one(sp.reauth) === '1';
  const google = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const dev = devLoginEnabled();

  return (
    <main id="main" className="container-narrow stack-lg" style={{ paddingTop: '3rem' }}>
      <div className="stack">
        <Logo size={40} />
        <h1>Recover staff sign in</h1>
        <p className="muted">For school staff and district administrators. Students do not need an account.</p>
      </div>
      {reauth ? (
        <Notice tone="warning" live="polite" title="Sign in again to continue">
          For your security, this action needs a recent sign-in. Sign in again to continue.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" live="assertive">
          {error}
        </Notice>
      ) : null}
      <div className="card card-pad-lg stack">
        {google ? (
          <form action={googleSignInAction}>
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <Button type="submit" variant="primary" size="lg" block icon={<IconShieldCheck />}>
              Sign in with Google
            </Button>
          </form>
        ) : (
          <p className="muted">Google sign-in is not configured in this environment.</p>
        )}
        <p className="hint with-icon" style={{ whiteSpace: 'normal' }}>
          <IconLock size={16} />
          Use your district Google account. Recover never asks for your password.
        </p>
      </div>
      {dev ? (
        <div className="card card-pad-lg stack">
          <h2>Development sign in</h2>
          <p className="hint">Local development only. This form does not exist on deployed environments.</p>
          <form action={devSignInAction} className="stack">
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <TextInput id="dev-email" label="Staff email" type="email" name="email" required autoComplete="email" />
            <Button type="submit" icon={<IconUser />}>
              Sign in (dev)
            </Button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
