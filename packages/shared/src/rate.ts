// Rate-limit table and client IP handling (§13.2, F-3, F-50; 13 Implementation guide).
// The SQL table behind api_rate_take mirrors LIMITS. Counters use fixed windows; raw IPs are never
// stored (callers HMAC the canonical IP with the monthly IP key before it reaches SQL).
import { isIPv4, isIPv6 } from 'node:net';

export type RateAction = 'post_item' | 'lost_report' | 'search' | 'status_poll' | 'search_all';
export type RateWindow = { readonly windowSeconds: number; readonly max: number };
export type Campus = 'onCampus' | 'offCampus';
export type ActionLimits = {
  readonly device: readonly RateWindow[]; // per school-scoped device digest, on or off campus
  readonly ip: Readonly<Record<Campus, readonly RateWindow[]>>; // per canonical client IP
};

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const w = (windowSeconds: number, max: number): RateWindow => ({ windowSeconds, max });

// §13.2 verbatim. An empty list means §13.2 sets no limit for that scope. Unknown IPs, and every IP
// until a school's campus CIDRs exist (O-3, G-42), get the off-campus limits.
export const LIMITS: Readonly<Record<RateAction, ActionLimits>> = {
  post_item: { device: [w(DAY, 3), w(WEEK, 6)], ip: { onCampus: [w(HOUR, 300)], offCampus: [w(HOUR, 10)] } },
  lost_report: { device: [w(DAY, 1)], ip: { onCampus: [], offCampus: [] } },
  search: { device: [w(10 * MINUTE, 60)], ip: { onCampus: [w(10 * MINUTE, 3000)], offCampus: [w(10 * MINUTE, 200)] } },
  status_poll: { device: [w(10 * MINUTE, 30)], ip: { onCampus: [], offCampus: [] } },
  // Cross-school search gets its own budget (Appendix B.2, F-79). §13.2 gives no numbers, so it is
  // sized like `search` but counted separately until the district tunes it.
  search_all: { device: [w(10 * MINUTE, 60)], ip: { onCampus: [w(10 * MINUTE, 3000)], offCampus: [w(10 * MINUTE, 200)] } },
};

// Fixed-window start (epoch-aligned), the `window_start` of a rate_counters row.
export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

// Canonical form before classification or HMAC: IPv4 dotted decimal; IPv4-mapped IPv6 collapsed to
// IPv4; other IPv6 lowercased and zero-compressed per RFC 5952 (the WHATWG URL serializer implements
// exactly that); brackets and zone ids stripped. Anything else is null.
export function canonicalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIPv4(s)) return s;
  if (!isIPv6(s)) return null;
  let host: string;
  try {
    host = new URL(`http://[${s}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const hi = Number.parseInt(mapped[1] ?? '0', 16);
  const lo = Number.parseInt(mapped[2] ?? '0', 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function toBytes(canonical: string): Uint8Array {
  if (canonical.includes('.')) return Uint8Array.from(canonical.split('.').map(Number));
  const [left = '', right] = canonical.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups = right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = Number.parseInt(g, 16);
    out[2 * i] = v >> 8;
    out[2 * i + 1] = v & 255;
  });
  return out;
}

// True when `ip` is inside any CIDR (IPv4 or IPv6; a bare address is a single host). Invalid CIDR
// entries are skipped, so a bad district entry degrades to the stricter off-campus limits.
export function ipInCidrs(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  const addr = canonicalizeIp(ip);
  if (!addr) return false;
  const a = toBytes(addr);
  for (const cidr of cidrs) {
    const slash = cidr.indexOf('/');
    const net = canonicalizeIp(slash < 0 ? cidr : cidr.slice(0, slash));
    if (!net) continue;
    const b = toBytes(net);
    if (a.length !== b.length) continue;
    const bitsText = slash < 0 ? String(b.length * 8) : cidr.slice(slash + 1).trim();
    const bits = /^\d{1,3}$/.test(bitsText) ? Number(bitsText) : Number.NaN;
    if (!(bits >= 0 && bits <= b.length * 8)) continue;
    let inside = true;
    for (let i = 0; i < bits && inside; i += 8) {
      const mask = (0xff << (8 - Math.min(8, bits - i))) & 0xff;
      inside = ((a[i / 8] ?? 0) & mask) === ((b[i / 8] ?? 0) & mask);
    }
    if (inside) return true;
  }
  return false;
}

export function classifyIp(ip: string | null | undefined, cidrs: readonly string[]): Campus {
  return ipInCidrs(ip, cidrs) ? 'onCampus' : 'offCampus';
}

export type HeaderReader = { get(name: string): string | null };

// Client IP from the platform's trusted primitive only (F-50). On Vercel that is `x-real-ip`, which
// the edge overwrites on every request (the same header @vercel/functions ipAddress() reads), with
// the platform's `x-vercel-forwarded-for` as a fallback when it holds exactly one address.
// `x-forwarded-for` is never read. Locally there is no trusted proxy, so the address is fixed.
// Returns null when the platform value is missing or malformed: treat that as off-campus.
export function clientIp(headers: HeaderReader, opts: { onVercel: boolean }): string | null {
  if (!opts.onVercel) return '127.0.0.1';
  return canonicalizeIp(headers.get('x-real-ip')) ?? canonicalizeIp(headers.get('x-vercel-forwarded-for'));
}
