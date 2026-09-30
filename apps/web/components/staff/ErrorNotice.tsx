import { Notice } from '@/components/ui/notice.tsx';

// Friendly notice for a failed page load, chosen by public error code (server or client).
const PAGE_MESSAGES: Record<string, string> = {
  not_found: 'We could not find that here.',
  forbidden: 'Your role does not allow viewing this.',
  unauthorized: 'Your session has ended. Please sign in again.',
  assertion_invalid: 'Your session could not be verified. Please sign in again.',
  feature_disabled: 'This feature is turned off right now.',
  upstream_unavailable: 'A service Recover depends on is unavailable. Please try again soon.',
  rate_limited: 'Too many requests. Please wait a moment and reload.',
  internal: 'Something went wrong loading this page. Please reload.',
};

export function ErrorNotice({ code, what, signinHref }: { code: string; what?: string; signinHref?: string }) {
  const message = PAGE_MESSAGES[code] ?? PAGE_MESSAGES.internal;
  const signIn = code === 'unauthorized' || code === 'assertion_invalid';
  return (
    <Notice tone="danger" live="assertive">
      {what ? <strong>{what}: </strong> : null}
      {message}{' '}
      {signIn ? <a href={signinHref ?? '/staff/signin'}>Sign in</a> : null}
    </Notice>
  );
}
