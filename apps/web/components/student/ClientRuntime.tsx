'use client';
// Registers the app-shell service worker for the student area (scope /s/; F-47) and reports uncaught
// browser errors as signatures only (§17 D-6). Never prompts for install.
import { useEffect } from 'react';
import { reportClientError } from './client-api.ts';

function errorClass(e: unknown): string {
  return e instanceof Error ? e.name : typeof e === 'object' && e !== null ? 'Object' : 'NonError';
}

export function ClientRuntime() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/s/', updateViaCache: 'none' }).catch(() => {});
    }
    let sent = 0;
    const onError = (e: ErrorEvent) => {
      if (sent++ < 5) reportClientError(errorClass(e.error));
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (sent++ < 5) reportClientError(errorClass(e.reason));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
