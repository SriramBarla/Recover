'use client';

import { useEffect } from 'react';

const PING_MS = 5 * 60 * 1000;

// Idle tracking (§14.1: 8 h idle). Server components cannot rewrite the session cookie, so the page
// pings the Auth.js session endpoint after user activity; that request runs the jwt callback,
// which refreshes lastSeen or ends the session. An ended session sends the user to sign in.
export function SessionKeepAlive() {
  useEffect(() => {
    let active = true; // the page view itself counts as activity
    let stopped = false;

    const ping = async () => {
      if (stopped || !active || document.visibilityState !== 'visible') return;
      active = false;
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
        const s = res.ok ? ((await res.json()) as { sub?: unknown } | null) : null;
        if (!s || typeof s.sub !== 'string' || !s.sub) {
          const back = `${window.location.pathname}${window.location.search}`;
          window.location.assign(`/staff/signin?error=expired&callbackUrl=${encodeURIComponent(back)}`);
        }
      } catch {
        // offline: try again after the next activity
      }
    };

    const mark = () => {
      active = true;
    };
    const events: (keyof WindowEventMap)[] = ['keydown', 'pointerdown', 'scroll'];
    for (const e of events) window.addEventListener(e, mark, { passive: true });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ping();
    };
    document.addEventListener('visibilitychange', onVisible);
    void ping();
    const timer = window.setInterval(() => void ping(), PING_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, mark);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return null;
}
