// Canonical Unicode policy for free text (F-102; 08 route skeleton step 5) and the deterministic
// contact-info check used at submit (§10.2 layer 1). No dependencies.
import { PublicError } from './errors.ts';

export type CleanTextOptions = {
  field: string; // reported as PublicError.field
  min: number; // inclusive, in code points after cleaning
  max: number; // inclusive, in code points after cleaning
  multiline?: boolean; // keep single line breaks
};

// Rejected outright: C0 controls (U+0000-U+001F; `\n` is allowed only in multiline mode), DEL, C1
// controls (U+0080-U+009F), the bidi marks, embeddings, overrides, and isolates (U+061C, U+200E,
// U+200F, U+202A-U+202E, U+2066-U+2069), and lone surrogates, which cannot be stored as UTF-8.
const BIDI = '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069';
const FORBIDDEN_LINE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${BIDI}]|\\p{Cs}`, 'u');
const FORBIDDEN_MULTILINE = new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f${BIDI}]|\\p{Cs}`, 'u');

// NFC-normalize, reject forbidden characters, collapse whitespace runs to one space (a run that
// contains a line break becomes a single `\n` in multiline mode), trim, then check the length in
// code points (the same unit as Postgres char_length).
export function cleanText(input: unknown, o: CleanTextOptions): string {
  if (typeof input !== 'string') throw new PublicError('invalid_input', o.field);
  const s = input.normalize('NFC');
  if ((o.multiline ? FORBIDDEN_MULTILINE : FORBIDDEN_LINE).test(s)) throw new PublicError('invalid_input', o.field);
  const collapsed = o.multiline
    ? s.replace(/\s+/g, (run) => (run.includes('\n') ? '\n' : ' '))
    : s.replace(/\s+/g, ' ');
  const out = collapsed.trim();
  const length = [...out].length;
  if (length < o.min || length > o.max) throw new PublicError('invalid_input', o.field);
  return out;
}

// Phone numbers, emails, URLs, @handles, and `snap:` / `ig:` style handles (§10.2). Matching runs on
// the NFKC form so full-width look-alikes (for example U+FF20 or full-width digits) are caught too.
const CONTACT: readonly RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i, // email
  /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|edu|gov|io|co|me|ly|gg|tv|app|us|info|biz|link|xyz)\b/i, // URL
  /(?:^|[^\w.@])@[a-z0-9_.]{2,}/i, // @handle
  /\b(?:snap(?:chat)?|ig|insta(?:gram)?|tiktok)\s*:/i, // snap:, ig:
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/, // 10-digit phone
  /\b\d{3}[\s.-]\d{4}\b/, // 7-digit phone with a separator (555-1234)
];

export function hasContactInfo(s: string): boolean {
  const t = s.normalize('NFKC');
  return CONTACT.some((re) => re.test(t));
}
