#!/usr/bin/env node
// Runbook 10 and the week-4 review (§11.3, §24 step 9; G-22): load packages/shared/src/synonyms.json,
// a flat {"term": ["expansion", ...]} object, into public.synonyms. Terms and expansions are normalized
// with private.search_norm (lowercase, unaccented, single spaces), the function the search SQL applies
// to queries, so the table check term = private.search_norm(term) always holds. Terms in the table but
// not in the file are kept unless --prune.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, UsageError, dryRunNote, isMain, printPlan, runScript, writeAudit } from './lib-ops.mjs';

const USAGE = `usage:
  node scripts/load-synonyms.mjs [--file <synonyms.json>] [--prune] [--yes]
The default file is packages/shared/src/synonyms.json. --prune also deletes terms that are not in it.
Without --yes nothing changes (dry run).
Common options: --db <url> (else env DB_URL, .env.local, local stack), --dry-run, --help.`;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const MAX_TERMS = 5000;
const MAX_EXPANSIONS = 20;
const shown = (f) => {
  const rel = path.relative(process.cwd(), f);
  return rel && !rel.startsWith('..') ? rel : f;
};

// Pure shape check: [{term, expansions}] in file order, or errors that name the entry.
export function validateSynonyms(data) {
  const errors = [];
  const entries = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { entries, errors: ['the file must hold one JSON object'] };
  const keys = Object.keys(data);
  if (keys.length > MAX_TERMS) errors.push(`${keys.length} terms; ${MAX_TERMS} at most`);
  for (const term of keys) {
    const list = data[term];
    const bad = (s) => typeof s !== 'string' || !s.trim() || s.length > 60 || CONTROL_RE.test(s);
    if (bad(term)) {
      errors.push(`term "${term.slice(0, 40)}" must be 1-60 characters without control characters`);
      continue;
    }
    if (!Array.isArray(list) || !list.length || list.length > MAX_EXPANSIONS) {
      errors.push(`${term}: expansions must be a list of 1-${MAX_EXPANSIONS} strings`);
      continue;
    }
    if (list.some(bad)) {
      errors.push(`${term}: every expansion must be 1-60 characters without control characters`);
      continue;
    }
    entries.push({ term, expansions: list });
  }
  return { entries, errors };
}

// Pure: merge normalized entries; drop empty and self expansions; report merges and empties.
export function mergeNormalized(entries, norm) {
  const merged = new Map();
  const notes = [];
  for (const { term, expansions } of entries) {
    const t = norm.get(term);
    if (!t) {
      notes.push(`"${term}" normalizes to nothing; skipped`);
      continue;
    }
    if (merged.has(t)) notes.push(`"${term}" merges into "${t}"`);
    const set = merged.get(t) ?? [];
    for (const e of expansions) {
      const n = norm.get(e);
      if (n && n !== t && !set.includes(n)) set.push(n);
    }
    merged.set(t, set);
  }
  for (const [t, set] of merged) {
    if (!set.length) {
      notes.push(`"${t}" has no expansion left after normalizing; skipped`);
      merged.delete(t);
    }
  }
  return { merged, notes };
}

export async function run({ values, apply, sql, requestId, say }) {
  const file = values.file ? path.resolve(values.file) : path.join(ROOT, 'packages/shared/src/synonyms.json');
  if (!existsSync(file)) {
    say(`${shown(file)} does not exist (the shared-modules branch adds it); nothing to load`);
    return 0;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${file} is not valid JSON (${e.message})`);
  }
  const { entries, errors } = validateSynonyms(data);
  if (errors.length) {
    errors.slice(0, 20).forEach((e) => say(`invalid: ${e}`));
    throw new Error(`${errors.length} problem(s) in ${file}; nothing was changed`);
  }
  const words = [...new Set(entries.flatMap((e) => [e.term, ...e.expansions]))];
  const rows = await sql`select t.v, private.search_norm(t.v) as n from unnest(${words}::text[]) as t(v)`;
  const { merged, notes } = mergeNormalized(entries, new Map(rows.map((r) => [r.v, r.n])));
  notes.slice(0, 20).forEach((n) => say(`note: ${n}`));

  const current = new Map((await sql`select term, expansions from public.synonyms`).map((r) => [r.term, r.expansions]));
  const added = [...merged.keys()].filter((t) => !current.has(t));
  const changed = [...merged.keys()].filter((t) => current.has(t) && current.get(t).join('\u0000') !== merged.get(t).join('\u0000'));
  const extra = [...current.keys()].filter((t) => !merged.has(t));
  const prune = values.prune === true;
  say(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${shown(file)}; ${merged.size} term(s) after normalizing; ${current.size} in public.synonyms`);
  const upserts = [...added, ...changed];
  if (!upserts.length && !(prune && extra.length)) {
    say(`public.synonyms already matches the file${extra.length ? ` (${extra.length} extra term(s) kept; --prune removes them)` : ''}`);
    return 0;
  }
  const few = (list) => (list.length ? `: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', ...' : ''}` : '');
  printPlan(say, [
    `insert ${added.length} term(s)${few(added)}`,
    `update ${changed.length} term(s)${few(changed)}`,
    prune ? `delete ${extra.length} term(s) not in the file${few(extra)}` : `keep ${extra.length} term(s) that are not in the file (--prune deletes them)`,
    `write audit_log runbook.load_synonyms (request_id ${requestId})`,
  ]);
  if (!apply) {
    dryRunNote(say);
    return 0;
  }
  const payload = Object.fromEntries(upserts.map((t) => [t, merged.get(t)]));
  await sql.begin(async (tx) => {
    if (upserts.length) {
      await tx`
        insert into public.synonyms (term, expansions)
        select e.key, array(select x.v from jsonb_array_elements_text(e.value) with ordinality as x(v, n) order by x.n)
          from jsonb_each(${tx.json(payload)}) as e
        on conflict (term) do update set expansions = excluded.expansions`;
    }
    if (prune && extra.length) await tx`delete from public.synonyms where term = any(${extra}::text[])`;
    await writeAudit(tx, {
      script: 'load-synonyms',
      action: 'runbook.load_synonyms',
      requestId,
      targetTable: 'synonyms',
      targetId: 'all',
      metadata: { terms: merged.size, added: added.length, changed: changed.length, removed: prune ? extra.length : 0, kept_extra: prune ? 0 : extra.length },
    });
  });
  say(`synonyms loaded (request_id ${requestId})`);
  return 0;
}

if (isMain(import.meta.url)) {
  await runScript({ name: 'load-synonyms', usage: USAGE, options: { file: { type: 'string' }, prune: { type: 'boolean' } }, run });
}
