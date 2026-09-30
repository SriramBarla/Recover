// Security headers for every web response (§19; G-09 CSP fix: uploads go to the storage S3 origin,
// capture previews use blob: URLs, and the browser never talks to the worker origin).
import { NextResponse, type NextRequest } from 'next/server';

function origin(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV !== 'production';
  const storage = origin(process.env.STORAGE_PUBLIC_URL);
  const s3 = origin(process.env.S3_ORIGIN);
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' blob: data: ${storage}`.trim(),
    `connect-src 'self' ${s3}${isDev ? ' ws:' : ''}`.trim(),
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    isDev ? '' : 'upgrade-insecure-requests',
  ]
    .filter(Boolean)
    .join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('permissions-policy', 'camera=(self), geolocation=(), microphone=()');
  if (!isDev) response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  const p = request.nextUrl.pathname;
  if (p.startsWith('/s/') || p.startsWith('/api/s/') || p.startsWith('/api/search-all')) {
    response.headers.set('x-robots-tag', 'noindex, noarchive, noimageindex');
  }
  return response;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/).*)' }],
};
