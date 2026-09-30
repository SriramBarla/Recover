// Thin helpers over Auth.js auth() (§14.1). The session exposes only {sub, authTime}; everything
// else (user, memberships, roles) is resolved per request in SQL (lib/staff.ts).
import { auth } from '../auth.ts';
import { STEP_UP_MAX_AGE_S, isFresh } from './ops.ts';

export type StaffAuth = { sub: string; authTime: number };

export async function currentSession(): Promise<StaffAuth | null> {
  let s: unknown;
  try {
    s = await auth();
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  const { sub, authTime } = s as { sub?: unknown; authTime?: unknown };
  if (typeof sub !== 'string' || !sub || typeof authTime !== 'number' || !Number.isFinite(authTime)) return null;
  return { sub, authTime };
}

export function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

export function sessionAgeS(s: StaffAuth): number {
  return Math.max(0, nowS() - s.authTime);
}

export function sessionIsFresh(s: StaffAuth, maxAgeS = STEP_UP_MAX_AGE_S): boolean {
  return isFresh(s.authTime, nowS(), maxAgeS);
}
