// Staff identity (§14.1): Auth.js v5, Google only in production, JWT sessions, no adapter.
// The session cookie carries only {sub, authTime, lastSeen}. Memberships are never cached in it;
// they are resolved per request through api_staff_resolve_session (lib/staff.ts).
// Sign-in binds the Google subject to an invited staff row via api_staff_bind_identity, which is
// assertion-gated (G-05). Nothing here logs sessions, subjects, or emails.
import NextAuth, { type NextAuthConfig, type Session } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { api } from './lib/db.ts';
import { devLoginEnabled, requireEnv } from './lib/env.ts';
import { SESSION_IDLE_S, domainAllowed, emailDomain, liveSession, prepareCall } from './lib/ops.ts';

const DEV_PROVIDER = 'dev-login';

type BindStatus = 'bound' | 'already_bound' | 'denied' | 'no_invite';

function signinError(code: string): string {
  return `/staff/signin?error=${encodeURIComponent(code)}`;
}

function keyVersion(): number {
  const v = Number.parseInt(requireEnv('STAFF_ASSERTION_KEY_VERSION'), 10);
  if (!Number.isSafeInteger(v) || v < 1) throw new Error('STAFF_ASSERTION_KEY_VERSION must be a positive integer');
  return v;
}

async function staffDomains(): Promise<string[]> {
  const r = await api<{ domains?: unknown }>('api_get_staff_domains');
  const list = Array.isArray(r?.domains) ? r.domains : [];
  return list.filter((d): d is string => typeof d === 'string').map((d) => d.toLowerCase());
}

// hd is only a hint for Google's account chooser (§14.1); the signIn callback enforces the domain.
let hint: { value: string | null; at: number } | null = null;
export async function staffDomainHint(): Promise<string | null> {
  const now = Date.now();
  if (hint && now - hint.at < 5 * 60_000) return hint.value;
  try {
    const domains = await staffDomains();
    hint = { value: domains[0] ?? null, at: now };
  } catch {
    hint = { value: null, at: now - 4 * 60_000 }; // retry in about a minute
  }
  return hint.value;
}

// api_staff_bind_identity(p_assert, p_google_sub, p_email) with a district-scope identity.bind
// assertion whose body is {email, google_sub} (G-05; contract section 6.2).
async function bindIdentity(sub: string, email: string): Promise<BindStatus | null> {
  const { params } = prepareCall({
    sub,
    operation: 'identity.bind',
    scope: 'district',
    args: { p_google_sub: sub, p_email: email },
    keyB64url: requireEnv('STAFF_ASSERTION_KEY_CURRENT'),
    keyVersion: keyVersion(),
  });
  const r = await api<{ status?: unknown }>('api_staff_bind_identity', params);
  const s = r?.status;
  return s === 'bound' || s === 'already_bound' || s === 'denied' || s === 'no_invite' ? s : null;
}

const providers: NextAuthConfig['providers'] = [];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // hd is added per request by the sign-in page from api_get_staff_domains (first domain),
      // because the allowlist lives in the database, not in the build.
      authorization: { params: { prompt: 'select_account' } },
    }),
  );
}

// Dev-only email login: exists only when RECOVER_DEV_LOGIN=1 and never on Vercel (lib/env.ts).
if (devLoginEnabled()) {
  providers.push(
    Credentials({
      id: DEV_PROVIDER,
      name: 'Dev login',
      credentials: { email: { label: 'Email', type: 'email' } },
      authorize: async (credentials) => {
        if (!devLoginEnabled()) return null;
        const email = typeof credentials?.email === 'string' ? credentials.email.normalize('NFC').trim().toLowerCase() : '';
        if (!emailDomain(email)) return null;
        return { id: `dev:${email}`, email };
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: 'jwt', maxAge: SESSION_IDLE_S },
  pages: { signIn: '/staff/signin', error: '/staff/signin' },
  logger: {
    error(error: Error) {
      const type = (error as { type?: unknown }).type;
      console.error(JSON.stringify({ level: 'error', event: 'auth_error', type: typeof type === 'string' ? type : error.name }));
    },
    warn(code: string) {
      console.warn(JSON.stringify({ level: 'warn', event: 'auth_warn', code }));
    },
    debug() {},
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      try {
        if (!account) return signinError('denied');
        let sub: string;
        let email: string;
        let checkDomain: boolean;
        if (account.provider === 'google') {
          if (profile?.email_verified !== true) return signinError('unverified');
          sub = typeof profile.sub === 'string' ? profile.sub : '';
          if (!sub || sub !== account.providerAccountId) return signinError('denied');
          email = typeof profile.email === 'string' ? profile.email.normalize('NFC').trim().toLowerCase() : '';
          checkDomain = true;
        } else if (account.provider === DEV_PROVIDER && devLoginEnabled()) {
          email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
          sub = `dev:${email}`;
          if (user.id !== sub || account.providerAccountId !== sub) return signinError('denied');
          checkDomain = false; // dev login skips the domain check
        } else {
          return signinError('denied');
        }
        if (!emailDomain(email)) return signinError('denied');
        if (checkDomain && !domainAllowed(email, await staffDomains())) return signinError('domain');
        const status = await bindIdentity(sub, email);
        if (status === 'bound' || status === 'already_bound') return true;
        return signinError('not_set_up');
      } catch {
        return signinError('unavailable');
      }
    },

    async jwt({ token, account, trigger }) {
      const nowS = Math.floor(Date.now() / 1000);
      if ((trigger === 'signIn' || trigger === 'signUp') && account) {
        const sub = account.providerAccountId;
        if (!sub) return null;
        return { sub, authTime: nowS, lastSeen: nowS };
      }
      const live = liveSession(token, nowS);
      if (!live) return null; // past 24 h absolute or 8 h idle: force a fresh sign-in
      return { sub: live.sub, authTime: live.authTime, lastSeen: nowS };
    },

    async session({ session, token }) {
      const live = liveSession(token, Math.floor(Date.now() / 1000));
      const out = { sub: live?.sub ?? '', authTime: live?.authTime ?? 0, expires: session.expires };
      return out as unknown as Session;
    },
  },
});
