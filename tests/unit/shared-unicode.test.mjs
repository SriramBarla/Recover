// Unicode policy (F-102) and contact-info detection (§10.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicError } from '../../packages/shared/src/errors.ts';
import { cleanText, hasContactInfo } from '../../packages/shared/src/unicode.ts';

const DESC = { field: 'description', min: 2, max: 120 };

function rejects(input, opts = DESC) {
  assert.throws(
    () => cleanText(input, opts),
    (e) => e instanceof PublicError && e.code === 'invalid_input' && e.field === opts.field && e.status === 400,
  );
}

test('NFC-normalizes decomposed text', () => {
  const decomposed = 'café bottle';
  const out = cleanText(decomposed, DESC);
  assert.equal(out, 'café bottle');
  assert.equal(out, out.normalize('NFC'));
});

test('collapses whitespace runs to one space and trims', () => {
  assert.equal(cleanText('  navy   metal   water　bottle  ', DESC), 'navy metal water bottle');
  assert.equal(cleanText('a b', DESC), 'a b');
  assert.equal(cleanText('﻿bottle', DESC), 'bottle');
});

test('single-line fields reject line breaks and tabs as controls', () => {
  rejects('navy\nbottle');
  rejects('navy\r\nbottle');
  rejects('navy\tbottle');
});

test('multiline keeps single newlines and collapses blank lines and spaces around them', () => {
  const opts = { field: 'hours', min: 1, max: 200, multiline: true };
  assert.equal(cleanText('Mon-Fri 7:30-4:00 \n\n\n  Sat closed  ', opts), 'Mon-Fri 7:30-4:00\nSat closed');
  assert.equal(cleanText('\n\nA\n', opts), 'A');
  assert.equal(cleanText('A    B', opts), 'A B');
  rejects('A\r\nB', opts);
  rejects('A\tB', opts);
});

test('rejects every C0 control, DEL, and every C1 control', () => {
  for (let cp = 0; cp <= 0x1f; cp++) rejects(`ab${String.fromCharCode(cp)}cd`);
  rejects('ab\u007fcd');
  for (let cp = 0x80; cp <= 0x9f; cp++) rejects(`ab${String.fromCharCode(cp)}cd`);
});

test('rejects bidi marks, embeddings, overrides, and isolates', () => {
  for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    rejects(`bottle ${String.fromCodePoint(cp)}evil`);
  }
});

test('rejects lone surrogates', () => {
  rejects('bottle \ud800');
  rejects('bottle \udc00x');
});

test('keeps ordinary multilingual text, emoji, and joiners', () => {
  for (const s of ['botella de agua azul', 'sudadera gris con capucha', 'Ñandú niño', 'بطری آب', '水筒 青', 'पानी की बोतल', 'family 👨‍👩‍👧 keychain', 'نیم‌فاصله']) {
    assert.equal(cleanText(s, { field: 'description', min: 1, max: 120 }), s.normalize('NFC'));
  }
});

test('length is counted in code points after cleaning', () => {
  assert.equal(cleanText('😀😀', DESC), '😀😀'); // 2 code points, 4 UTF-16 units
  rejects('😀', DESC);
  assert.equal(cleanText('éé', DESC), 'éé'); // 4 code points before NFC, 2 after
  assert.equal(cleanText('x'.repeat(120), DESC).length, 120);
  rejects('x'.repeat(121));
  assert.equal([...cleanText('😀'.repeat(120), DESC)].length, 120);
  rejects('😀'.repeat(121));
  rejects('  a      ', DESC); // 1 code point after trimming
  assert.equal(cleanText('   ', { field: 'note', min: 0, max: 80 }), '');
});

test('non-string input is invalid_input with the field name', () => {
  for (const v of [undefined, null, 42, {}, ['a', 'b'], true]) rejects(v, { field: 'note', min: 0, max: 80 });
});

test('hasContactInfo flags phones, emails, URLs, handles, snap: and ig:', () => {
  const positives = [
    'call 404-555-1234',
    'call (404) 555-1234',
    'text 404.555.1234',
    'my number 4045551234',
    '+1 404 555 1234',
    'call me 555-1234',
    'email jane.doe@example.com',
    'JANE@SCHOOL.K12.GA.US',
    'see https://example.org/x',
    'http://x.y',
    'www.lostfound.net',
    'example.com has it',
    'bit.ly/abc123',
    'discord.gg/abc',
    'dm @jane_doe',
    '@jane',
    'snap: janed',
    'Snapchat:janed',
    'ig: jane',
    'IG:jane',
    'insta: jane',
    'tiktok: jane',
    'full width ＠jane', // NFKC turns U+FF20 into @
    '４０４５５５１２３４', // full-width digits
  ];
  for (const s of positives) assert.equal(hasContactInfo(s), true, s);
});

test('hasContactInfo does not flag ordinary item descriptions', () => {
  const negatives = [
    'navy metal water bottle',
    'black North Face jacket size M',
    'FCHS-W-000214',
    'size 10.5 nike shoes',
    'class of 2024-2025 hoodie',
    'room 214 near the gym',
    'lock combo 12-34-56 on it',
    'TI-84 calculator',
    'hydro.flask with stickers',
    'found at the big: green tote',
    'found on 2026-09-30 at 3:15',
    'zip 30303-1234 printed on tag',
    'snap button jacket',
    'botella azul',
    'jane doe',
  ];
  for (const s of negatives) assert.equal(hasContactInfo(s), false, s);
});
