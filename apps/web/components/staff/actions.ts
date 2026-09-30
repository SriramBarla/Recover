'use server';

// Sign-in and sign-out server actions for the staff app (§14.1). Server actions are same-origin
// POSTs that Next.js checks against the Host header.
import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn, signOut, staffDomainHint } from '../../auth.ts';
import { devLoginEnabled } from '../../lib/env.ts';
import { safeReturnPath } from '../../lib/ops.ts';

export async function googleSignInAction(formData: FormData): Promise<void> {
  const callbackUrl = safeReturnPath(formData.get('callbackUrl'), '/staff');
  const hd = await staffDomainHint();
  // hd is a hint for Google's account chooser only; the signIn callback enforces the domain.
  await signIn('google', { redirectTo: callbackUrl }, hd ? { hd } : undefined);
}

export async function devSignInAction(formData: FormData): Promise<void> {
  const callbackUrl = safeReturnPath(formData.get('callbackUrl'), '/staff');
  if (!devLoginEnabled()) redirect('/staff/signin?error=denied');
  const email = String(formData.get('email') ?? '').slice(0, 254);
  try {
    await signIn('dev-login', { email, redirectTo: callbackUrl });
  } catch (e) {
    if (e instanceof AuthError) {
      redirect(`/staff/signin?error=CredentialsSignin&callbackUrl=${encodeURIComponent(callbackUrl)}`);
    }
    throw e;
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/staff/signin' });
}
