// synonyms.json format (12 Implementation guide "Synonyms file format"; §11.3). The SQL loader
// expands query tokens with these canonical English terms, so keys are single lowercase unaccented
// tokens and values are lowercase unaccented terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../../packages/shared/src/synonyms.json', import.meta.url), 'utf8');
const synonyms = JSON.parse(raw);

test('is a flat object of about 90 entries with sorted keys', () => {
  assert.equal(typeof synonyms, 'object');
  assert.ok(!Array.isArray(synonyms));
  const keys = Object.keys(synonyms);
  assert.ok(keys.length >= 80 && keys.length <= 110, `${keys.length} entries`);
  assert.deepEqual(keys, [...keys].sort());
});

test('keys are single lowercase ASCII tokens; values are lowercase ASCII terms', () => {
  assert.match(raw, /^[\x00-\x7f]*$/, 'unaccented (ASCII only)');
  for (const [key, terms] of Object.entries(synonyms)) {
    assert.match(key, /^[a-z0-9]+$/, key);
    assert.ok(Array.isArray(terms) && terms.length > 0, key);
    assert.equal(new Set(terms).size, terms.length, `${key} has duplicate terms`);
    for (const t of terms) {
      assert.match(t, /^[a-z0-9]+( [a-z0-9]+)*$/, `${key}: ${t}`);
      assert.notEqual(t, key, `${key} maps to itself`);
    }
  }
});

test('includes the examples from §11.3 and the 12 format sample', () => {
  assert.deepEqual(synonyms.hydroflask, ['water bottle']);
  assert.deepEqual(synonyms.stanley, ['tumbler', 'water bottle']);
  assert.deepEqual(synonyms.airpods, ['earbuds']);
  assert.deepEqual(synonyms.botella, ['bottle', 'water bottle']);
  assert.deepEqual(synonyms.mochila, ['backpack', 'bag']);
  assert.deepEqual(synonyms.sudadera, ['hoodie', 'sweatshirt']);
  assert.ok(synonyms.chromebook.includes('laptop'));
  assert.ok(synonyms.crocs.includes('shoes'));
});

test('covers common Spanish item nouns', () => {
  const spanish = [
    'abrigo', 'anillo', 'aretes', 'audifonos', 'bolsa', 'botella', 'bufanda', 'calculadora', 'camisa', 'cargador',
    'carpeta', 'cartera', 'celular', 'chamarra', 'chaqueta', 'computadora', 'cuaderno', 'gorra', 'guantes', 'lentes',
    'libro', 'llaves', 'lonchera', 'mochila', 'pantalones', 'paraguas', 'pelota', 'pulsera', 'reloj', 'sudadera',
    'sueter', 'tenis', 'termo', 'zapatos',
  ];
  for (const k of spanish) assert.ok(Array.isArray(synonyms[k]), k);
  const english = Object.keys(synonyms).length - spanish.length;
  assert.ok(english >= 55 && english <= 70, `${english} English entries`);
});
