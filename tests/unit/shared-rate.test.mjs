// Rate limits (§13.2), IP canonicalization and campus classification (F-3, F-50).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, canonicalizeIp, classifyIp, clientIp, ipInCidrs, windowStart } from '../../packages/shared/src/rate.ts';

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;

test('LIMITS mirrors §13.2 exactly', () => {
  assert.deepEqual(LIMITS.post_item, {
    device: [{ windowSeconds: DAY, max: 3 }, { windowSeconds: WEEK, max: 6 }],
    ip: { onCampus: [{ windowSeconds: HOUR, max: 300 }], offCampus: [{ windowSeconds: HOUR, max: 10 }] },
  });
  assert.deepEqual(LIMITS.lost_report, { device: [{ windowSeconds: DAY, max: 1 }], ip: { onCampus: [], offCampus: [] } });
  assert.deepEqual(LIMITS.search, {
    device: [{ windowSeconds: 10 * MIN, max: 60 }],
    ip: { onCampus: [{ windowSeconds: 10 * MIN, max: 3000 }], offCampus: [{ windowSeconds: 10 * MIN, max: 200 }] },
  });
  assert.deepEqual(LIMITS.status_poll, { device: [{ windowSeconds: 10 * MIN, max: 30 }], ip: { onCampus: [], offCampus: [] } });
});

test('search_all has its own budget, sized like search', () => {
  assert.deepEqual(LIMITS.search_all, LIMITS.search);
  assert.notEqual(LIMITS.search_all, LIMITS.search);
});

test('every action has the same shape and positive integer windows', () => {
  assert.deepEqual(Object.keys(LIMITS).sort(), ['lost_report', 'post_item', 'search', 'search_all', 'status_poll']);
  for (const [action, l] of Object.entries(LIMITS)) {
    assert.ok(l.device.length > 0, `${action} has a device limit`);
    for (const win of [...l.device, ...l.ip.onCampus, ...l.ip.offCampus]) {
      assert.ok(Number.isInteger(win.windowSeconds) && win.windowSeconds > 0, action);
      assert.ok(Number.isInteger(win.max) && win.max > 0, action);
    }
  }
});

test('windowStart aligns to fixed epoch windows', () => {
  const t = new Date('2026-09-30T14:07:59.999Z');
  assert.equal(windowStart(t, 10 * MIN).toISOString(), '2026-09-30T14:00:00.000Z');
  assert.equal(windowStart(t, HOUR).toISOString(), '2026-09-30T14:00:00.000Z');
  assert.equal(windowStart(t, DAY).toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(windowStart(new Date('2026-09-30T14:10:00.000Z'), 10 * MIN).toISOString(), '2026-09-30T14:10:00.000Z');
  // Weeks are epoch-aligned (1970-01-01 was a Thursday).
  assert.equal(windowStart(t, WEEK).toISOString(), '2026-09-24T00:00:00.000Z');
});

test('canonicalizeIp: IPv4 passes; malformed input is null', () => {
  assert.equal(canonicalizeIp('203.0.113.7'), '203.0.113.7');
  assert.equal(canonicalizeIp('  203.0.113.7 '), '203.0.113.7');
  for (const bad of [null, undefined, '', ' ', '203.0.113', '203.0.113.256', '01.2.3.4', '1.2.3.4:80', 'example.com', '1.2.3.4, 5.6.7.8', '::g', '1:2:3:4:5:6:7:8:9', '[::1]:443']) {
    assert.equal(canonicalizeIp(bad), null, String(bad));
  }
});

test('canonicalizeIp: IPv4-mapped IPv6 becomes IPv4', () => {
  assert.equal(canonicalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(canonicalizeIp('::FFFF:cb00:7107'), '203.0.113.7');
  assert.equal(canonicalizeIp('0:0:0:0:0:ffff:cb00:7107'), '203.0.113.7');
  assert.equal(canonicalizeIp('::ffff:0:0'), '0.0.0.0');
});

test('canonicalizeIp: IPv6 is lowercased and zero-compressed per RFC 5952', () => {
  assert.equal(canonicalizeIp('2001:0DB8:0000:0000:0000:FF00:0042:8329'), '2001:db8::ff00:42:8329');
  assert.equal(canonicalizeIp('2001:db8:0:0:1:0:0:1'), '2001:db8::1:0:0:1'); // first of equal runs
  assert.equal(canonicalizeIp('1:0:0:1:0:0:0:1'), '1:0:0:1::1'); // longest run
  assert.equal(canonicalizeIp('1:2:3:4:5:6:7:0'), '1:2:3:4:5:6:7:0'); // a single zero is not compressed
  assert.equal(canonicalizeIp('0:0:0:0:0:0:0:1'), '::1');
  assert.equal(canonicalizeIp('::'), '::');
  assert.equal(canonicalizeIp('[2001:db8::1]'), '2001:db8::1');
});

test('canonicalizeIp: zone ids are stripped', () => {
  assert.equal(canonicalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(canonicalizeIp('FE80:0:0:0:0:0:0:1%25en0'), 'fe80::1');
});

test('equivalent spellings canonicalize to the same value (stable HMAC input)', () => {
  const forms = ['2001:db8::1', '2001:DB8::1', '2001:0db8:0:0:0:0:0:0001', '2001:db8:0::0:1', '[2001:db8::1]'];
  assert.equal(new Set(forms.map(canonicalizeIp)).size, 1);
  assert.deepEqual([...new Set(['10.1.2.3', '::ffff:10.1.2.3', '::ffff:a01:203'].map(canonicalizeIp))], ['10.1.2.3']);
});

test('ipInCidrs: IPv4', () => {
  const cidrs = ['10.20.0.0/16', '192.0.2.10/32', '198.51.100.0/22'];
  assert.equal(ipInCidrs('10.20.255.1', cidrs), true);
  assert.equal(ipInCidrs('10.21.0.1', cidrs), false);
  assert.equal(ipInCidrs('192.0.2.10', cidrs), true);
  assert.equal(ipInCidrs('192.0.2.11', cidrs), false);
  assert.equal(ipInCidrs('198.51.103.255', cidrs), true);
  assert.equal(ipInCidrs('198.51.104.0', cidrs), false);
  assert.equal(ipInCidrs('203.0.113.9', ['0.0.0.0/0']), true);
  assert.equal(ipInCidrs('203.0.113.9', ['203.0.113.9']), true); // bare address = single host
});

test('ipInCidrs: IPv6 and IPv4-mapped clients', () => {
  const cidrs = ['2001:db8:abcd::/48', '10.0.0.0/8'];
  assert.equal(ipInCidrs('2001:db8:abcd:12::7', cidrs), true);
  assert.equal(ipInCidrs('2001:DB8:ABCD:FFFF:FFFF:FFFF:FFFF:FFFF', cidrs), true);
  assert.equal(ipInCidrs('2001:db8:abce::1', cidrs), false);
  assert.equal(ipInCidrs('::ffff:10.9.8.7', cidrs), true); // mapped client matches the IPv4 range
  assert.equal(ipInCidrs('fe80::1%eth0', ['fe80::/10']), true);
  assert.equal(ipInCidrs('2001:db8::1', ['2001:db8::/33']), true);
  assert.equal(ipInCidrs('2001:db8:8000::1', ['2001:db8::/33']), false);
});

test('ipInCidrs: families never cross, invalid entries are skipped, bad input is false', () => {
  assert.equal(ipInCidrs('10.0.0.1', ['::/0']), false);
  assert.equal(ipInCidrs('2001:db8::1', ['0.0.0.0/0']), false);
  assert.equal(ipInCidrs('10.0.0.1', ['nonsense', '10.0.0.0/33', '10.0.0.0/x', '10.0.0.0/-1', '10.0.0.0/8']), true);
  assert.equal(ipInCidrs('10.0.0.1', ['nonsense', '10.0.0.0/33']), false);
  assert.equal(ipInCidrs(null, ['0.0.0.0/0']), false);
  assert.equal(ipInCidrs('not an ip', ['0.0.0.0/0']), false);
  assert.equal(ipInCidrs('10.0.0.1', []), false);
});

test('classifyIp picks the LIMITS key; unknown IPs are off campus', () => {
  const cidrs = ['10.0.0.0/8'];
  assert.equal(classifyIp('10.1.1.1', cidrs), 'onCampus');
  assert.equal(classifyIp('8.8.8.8', cidrs), 'offCampus');
  assert.equal(classifyIp(null, cidrs), 'offCampus');
  assert.equal(classifyIp('10.1.1.1', []), 'offCampus'); // no campus ranges yet (O-3)
  assert.deepEqual(LIMITS.post_item.ip[classifyIp('10.1.1.1', cidrs)], [{ windowSeconds: HOUR, max: 300 }]);
});

test('clientIp: Vercel trusts only the platform headers, never x-forwarded-for', () => {
  const h = (o) => new Headers(o);
  assert.equal(clientIp(h({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6' }), { onVercel: true }), '203.0.113.7');
  assert.equal(clientIp(h({ 'x-real-ip': '::ffff:203.0.113.7' }), { onVercel: true }), '203.0.113.7');
  assert.equal(clientIp(h({ 'x-vercel-forwarded-for': '2001:DB8::1' }), { onVercel: true }), '2001:db8::1');
  assert.equal(clientIp(h({ 'x-real-ip': 'garbage', 'x-vercel-forwarded-for': '198.51.100.4' }), { onVercel: true }), '198.51.100.4');
  assert.equal(clientIp(h({ 'x-vercel-forwarded-for': '1.1.1.1, 2.2.2.2' }), { onVercel: true }), null);
  assert.equal(clientIp(h({ 'x-forwarded-for': '6.6.6.6' }), { onVercel: true }), null);
  assert.equal(clientIp(h({}), { onVercel: true }), null);
});

test('clientIp: locally the address is fixed and headers are ignored', () => {
  const headers = new Headers({ 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '7.7.7.7' });
  assert.equal(clientIp(headers, { onVercel: false }), '127.0.0.1');
  assert.equal(clientIp({ get: () => null }, { onVercel: false }), '127.0.0.1');
});
