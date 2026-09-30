// Step 4 of the student skeleton: fixed-window limits per device and per IP (§13.2; F-50).
// The client IP comes only from the platform's trusted primitive (clientIp), is canonicalized, then HMACed
// with a monthly purpose-separated subkey; the raw address is never stored or logged. Campus CIDRs are not
// configured yet (O-3), so every address gets the off-campus limits (p_on_campus false).
import { monthlyHmac } from '@recover/shared/crypto.ts';
import { canonicalizeIp, clientIp } from '@recover/shared/rate.ts';
import { api } from './db.ts';
import { onVercel, requireEnv } from './env.ts';

export type RateAction = 'post_item' | 'lost_report' | 'search' | 'status_poll';

export function ipHmac(headers: Headers): Buffer {
  let ip = 'unknown';
  try {
    const raw = clientIp(headers, { onVercel: onVercel() });
    const canonical = raw ? canonicalizeIp(raw) : null;
    if (canonical) ip = canonical;
  } catch {
    // unparseable address: every such request shares one bucket, which fails toward stricter limits
  }
  return monthlyHmac(requireEnv('IP_KEY'), 'ip', ip);
}

// Raises PublicError('rate_limited', retrySeconds) from SQL when a counter is exhausted. A request with no
// device cookie (a first search) is limited by IP only.
export async function take(
  schoolCode: string,
  action: RateAction,
  digest: Buffer | null,
  req: { headers: Headers },
): Promise<void> {
  await api('api_rate_take', {
    p_school_code: schoolCode,
    p_action: action,
    p_device_hmac: digest,
    p_ip_hmac: ipHmac(req.headers),
    p_on_campus: false,
  });
}
