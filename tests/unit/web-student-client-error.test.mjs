// Browser error beacon signatures (security review L1; §17 D-6; G-29): the unauthenticated /api/client-error
// counts a signature only when its error class and route template are allowlisted, stores a server-built value
// that api_record_error accepts, and refuses everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ERROR_CLASSES, CLIENT_ERROR_ROUTES, clientErrorSignature } from '../../apps/web/lib/client-error.ts';
import { routeTemplate } from '../../apps/web/components/student/client-api.ts';

// The 0200 api_record_error pattern (0210 only adds a space, which these signatures never use).
const SQL_SIGNATURE_0200 = /^[A-Za-z0-9_:/.\[\]-]{1,120}$/;

// Every student page, as the browser's location.pathname.
const PAGES = {
  '/s/FCHS': '/s/[code]',
  '/s/FCHS/found': '/s/[code]/found',
  '/s/FCHS/items/FCHS-E-990001': '/s/[code]/items/[publicId]',
  '/s/FCHS/search': '/s/[code]/search',
  '/s/FCHS/lost': '/s/[code]/lost',
  '/s/FCHS/lost/mine': '/s/[code]/lost/mine',
  '/s/FCHS/mine': '/s/[code]/mine',
  '/offline': '/offline',
};

test('every student page and allowlisted class maps to a fixed signature SQL accepts', () => {
  for (const [path, route] of Object.entries(PAGES)) {
    for (const cls of CLIENT_ERROR_CLASSES) {
      const sent = `${cls}:${routeTemplate(path)}`; // exactly what reportClientError posts
      const stored = clientErrorSignature(sent);
      assert.equal(stored, `client:${route}:${cls}`, sent);
      assert.match(stored, SQL_SIGNATURE_0200, stored);
      assert.ok(!stored.includes('*'), 'no wildcard reaches SQL');
    }
  }
  assert.equal(CLIENT_ERROR_ROUTES.size, Object.keys(PAGES).length, 'the allowlist has no route the pages cannot produce');
});

test('the classes the student code reports are allowlisted', () => {
  for (const cls of ['render_error', 'upload_failed', 'Error', 'TypeError', 'ChunkLoadError', 'AbortError', 'Object', 'NonError']) {
    assert.ok(CLIENT_ERROR_CLASSES.has(cls), cls);
  }
});

test('anything off the allowlist is refused', () => {
  const refused = [
    undefined,
    null,
    42,
    {},
    ['TypeError:/s/*'],
    '',
    'TypeError',
    ':/s/*',
    'TypeError:',
    'TypeError:/s/*/',
    'TypeError:/s/*/*',
    'TypeError:/s/*/items',
    'TypeError:/staff/*/queue',
    'TypeError:/s/FCHS/found',
    'TypeError:/s/[code]/found',
    'MyCustomError:/s/*/found',
    'typeerror:/s/*/found',
    ' TypeError:/s/*/found',
    'TypeError:/s/*/found ',
    'TypeError:/s/*/found:extra',
    'client:TypeError:/s/*/found',
    'Error:/s/*/search?q=my phone number',
    `TypeError:/s/*/found${'/x'.repeat(60)}`,
    `${'A'.repeat(101)}:/s/*`,
  ];
  for (const raw of refused) assert.equal(clientErrorSignature(raw), null, JSON.stringify(raw));
});
