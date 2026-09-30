// Step 4 of the student skeleton: fixed-window limits per device and per IP (§13.2; F-50).
// The client IP comes only from the platform's trusted primitive (clientIp, already canonical), then is
// HMACed with a monthly purpose-separated subkey; the raw address is never stored or logged. Campus CIDRs
// are not configured yet (O-3), so every address gets the off-campus limits (p_on_campus false).
import { monthlyHmac } from '@recover/shared/crypto.ts';
import { clientIp, type HeaderReader, type RateAction } from '@recover/shared/rate.ts';
import { api } from './db.ts';
import { onVercel, requireEnv } from './env.ts';

export type { RateAction };

// A missing or malformed platform address shares one bucket, which fails toward the stricter limit.
export function ipHmac(headers: HeaderReader): Buffer {
  return monthlyHmac(requireEnv('IP_KEY'), 'ip', clientIp(headers, { onVercel: onVercel() }) ?? 'unknown');
}

// Raises PublicError('rate_limited', retrySeconds) from SQL when a counter is exhausted. A request with no
// device cookie (a first search) is limited by IP only. schoolCode is null only for the school-less
// client_error action (one district-wide budget per address); SQL refuses any other pairing.
export async function take(
  schoolCode: string | null,
  action: RateAction,
  digest: Buffer | null,
  req: { headers: HeaderReader },
): Promise<void> {
  await api('api_rate_take', {
    p_school_code: schoolCode,
    p_action: action,
    p_device_hmac: digest,
    p_ip_hmac: ipHmac(req.headers),
    p_on_campus: false,
  });
}
