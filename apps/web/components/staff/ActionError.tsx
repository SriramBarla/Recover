'use client';

import { errorMessage, needsSignIn, signInAgainHref } from './client-api.ts';

// Inline error for an action; offers a fresh sign-in when the session ended or step-up is needed.
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="field-error" role="alert">
      {errorMessage(error)}{' '}
      {needsSignIn(error) ? <a href={signInAgainHref()}>Sign in again</a> : null}
    </p>
  );
}
