// Staff session windows and identity helpers (§14.1: 24 h absolute, 8 h idle, exact domain match;
// G-31 step-up), plus the post-sign-in redirect allowlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_ABSOLUTE_S,
  SESSION_IDLE_S,
  authTimeFrom,
  domainAllowed,
  emailDomain,
  googleAuthParams,
  isFresh,
  liveSession,
  safeReturnPath,
} from '../../apps/web/lib/ops.ts';

const NOW = 1_790_000_000;

test('a fresh token is live', () => {
  assert.deepEqual(liveSession({ sub: 'abc', authTime: NOW - 60, signedInAt: NOW - 50, lastSeen: NOW - 30 }, NOW), {
    sub: 'abc',
    authTime: NOW - 60,
    signedInAt: NOW - 50,
  });
  // tokens issued before signedInAt existed: authTime was the issue time
  assert.deepEqual(liveSession({ sub: 'abc', authTime: NOW - 60, lastSeen: NOW - 30 }, NOW), { sub: 'abc', authTime: NOW - 60, signedInAt: NOW - 60 });
});

test('the absolute window runs from signedInAt, so an old Google authentication is live but not fresh (G-31)', () => {
  const t = { sub: 'a', authTime: NOW - 30 * 86_400, signedInAt: NOW - 60, lastSeen: NOW - 60 };
  const live = liveSession(t, NOW);
  assert.ok(live);
  assert.equal(live.authTime, NOW - 30 * 86_400);
  assert.ok(!isFresh(live.authTime, NOW), 'destructive actions still need a step-up');
  assert.equal(liveSession({ ...t, signedInAt: NOW - SESSION_ABSOLUTE_S - 1 }, NOW), null);
  assert.equal(liveSession({ ...t, signedInAt: NOW + 3600 }, NOW), null, 'future-dated issue time');
  assert.equal(liveSession({ ...t, signedInAt: 'today' }, NOW), null, 'a malformed signedInAt falls back to authTime, here past 24 h');
});

test('authTime comes from the ID token auth_time claim, never later than now; else the server clock (V-6)', () => {
  assert.equal(authTimeFrom(NOW - 3600, NOW), NOW - 3600);
  assert.equal(authTimeFrom(NOW - 3600.9, NOW), NOW - 3601);
  assert.equal(authTimeFrom(NOW + 120, NOW), NOW, 'clock skew never makes a session fresher than now');
  for (const missing of [undefined, null, '1790000000', 0, -5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(authTimeFrom(missing, NOW), NOW, String(missing));
  }
});

test('a step-up sign-in forces re-authentication at Google; a plain sign-in keeps the chooser (G-31)', () => {
  assert.deepEqual(googleAuthParams({ hd: null, stepUp: false }), {});
  assert.deepEqual(googleAuthParams({ hd: 'district.org', stepUp: false }), { hd: 'district.org' });
  assert.deepEqual(googleAuthParams({ hd: 'district.org', stepUp: true }), { hd: 'district.org', prompt: 'login', max_age: '0' });
  assert.deepEqual(googleAuthParams({ hd: null, stepUp: true }), { prompt: 'login', max_age: '0' });
});

test('the 24 h absolute window ends the session even with recent activity', () => {
  assert.equal(SESSION_ABSOLUTE_S, 86_400);
  assert.ok(liveSession({ sub: 'a', authTime: NOW - SESSION_ABSOLUTE_S, lastSeen: NOW }, NOW));
  assert.equal(liveSession({ sub: 'a', authTime: NOW - SESSION_ABSOLUTE_S - 1, lastSeen: NOW }, NOW), null);
});

test('the 8 h idle window ends the session', () => {
  assert.equal(SESSION_IDLE_S, 28_800);
  assert.ok(liveSession({ sub: 'a', authTime: NOW - 9 * 3600, lastSeen: NOW - SESSION_IDLE_S }, NOW));
  assert.equal(liveSession({ sub: 'a', authTime: NOW - 9 * 3600, lastSeen: NOW - SESSION_IDLE_S - 1 }, NOW), null);
  // lastSeen missing falls back to authTime
  assert.equal(liveSession({ sub: 'a', authTime: NOW - SESSION_IDLE_S - 1 }, NOW), null);
});

test('malformed or future-dated tokens are not live', () => {
  assert.equal(liveSession({ authTime: NOW }, NOW), null);
  assert.equal(liveSession({ sub: '', authTime: NOW }, NOW), null);
  assert.equal(liveSession({ sub: 'a', authTime: 'yesterday' }, NOW), null);
  assert.equal(liveSession({ sub: 'a', authTime: NOW + 3600 }, NOW), null);
});

test('step-up freshness is 10 minutes by default (G-31)', () => {
  assert.ok(isFresh(NOW - 600, NOW));
  assert.ok(!isFresh(NOW - 601, NOW));
  assert.ok(isFresh(NOW - 3000, NOW, 3600));
  assert.ok(!isFresh(NOW + 3600, NOW));
});

test('email domains are parsed exactly', () => {
  assert.equal(emailDomain('pat@district.k12.ga.us'), 'district.k12.ga.us');
  assert.equal(emailDomain('pat@@district.org'), null);
  assert.equal(emailDomain('pat@district'), null);
  assert.equal(emailDomain('@district.org'), null);
  assert.equal(emailDomain('pat @district.org'), null);
  assert.equal(emailDomain('pat@district.org.'), null);
});

test('domain allowlist uses exact matches, never suffixes or substrings', () => {
  const allowed = ['district.org', 'k12.district.org'];
  assert.ok(domainAllowed('pat@district.org', allowed));
  assert.ok(domainAllowed('pat@k12.district.org', ['K12.District.org']));
  assert.ok(!domainAllowed('pat@evildistrict.org', allowed));
  assert.ok(!domainAllowed('pat@students.district.org', allowed));
  assert.ok(!domainAllowed('pat@district.org.evil.com', allowed));
  assert.ok(!domainAllowed('pat@district.org', []));
});

test('post-sign-in redirects stay inside the staff and district apps', () => {
  assert.equal(safeReturnPath('/staff/FCHS/queue'), '/staff/FCHS/queue');
  assert.equal(safeReturnPath('/district/maps'), '/district/maps');
  assert.equal(safeReturnPath('/staff?x=1'), '/staff?x=1');
  assert.equal(safeReturnPath('https://evil.example/staff'), '/staff');
  assert.equal(safeReturnPath('//evil.example/staff'), '/staff');
  assert.equal(safeReturnPath('/staff//evil.example'), '/staff');
  assert.equal(safeReturnPath('/s/FCHS'), '/staff');
  assert.equal(safeReturnPath('/staff\\..'), '/staff');
  assert.equal(safeReturnPath(undefined, '/district'), '/district');
});
