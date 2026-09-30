// Worker edge guard (F-123, G-18). Anything that is not one of the six worker routes, including unknown
// paths and automatic OPTIONS/HEAD handling, gets the only unauthenticated response the worker ever
// returns: an empty 401. The route handlers still authenticate first; this only closes the framework's
// own responses (404 pages, 405s, OPTIONS 204s).
import { NextResponse, type NextRequest } from 'next/server';

const ALLOWED: readonly (readonly [string, RegExp])[] = [
  ['POST', /^\/api\/jobs\/run$/],
  ['POST', /^\/api\/media\/(?:upload-spec|complete-check|map-draft|map-activate)$/],
  ['GET', /^\/api\/media\/ticket\/[0-9A-Fa-f-]{36}$/],
];

export function proxy(request: NextRequest): Response {
  const path = request.nextUrl.pathname;
  if (ALLOWED.some(([method, re]) => method === request.method && re.test(path))) return NextResponse.next();
  return new Response(null, { status: 401 });
}
