// Advisory photo screening (§10.2 layer 3, §10.3; 11 Implementation guide; F-53, F-92, F-109; G-24).
// Vision only ever sees canonical JPEG bytes. OCR text feeds two regex signals inside deriveSignals
// and is then dropped: it is never stored, logged, or returned.
import { hasMetadataSegments, sniff } from './magic.ts';
import { PermanentError, RetryableError } from '../jobs/errors.ts';
import type { FetchLike } from '../storage.ts';

export type VisionMode = 'off' | 'mock' | 'google';

export type Signals = {
  nsfw: boolean;
  nsfw_score: number;
  has_face: boolean;
  face_count: number;
  has_text: boolean;
  text_char_count: number;
  contact_info: boolean;
  name_like: boolean;
  severe: boolean;
  // Partial results only (§10.4): which feature came back empty. Booleans, because SQL keeps only
  // boolean and number signals (F-53).
  missing_safe_search?: boolean;
  missing_face?: boolean;
  missing_text?: boolean;
};

export type ScreenOutcome = { provider: string; model: string; status: 'ok' | 'partial'; signals: Signals };

export type Vision = {
  mode: VisionMode;
  provider: string;
  model: string;
  // null only in `off` mode: the item stays unscreened.
  screen(jpeg: Buffer): Promise<ScreenOutcome | null>;
};

export type AnnotateResponse = {
  safeSearchAnnotation?: { adult?: string; racy?: string; violence?: string };
  faceAnnotations?: { detectionConfidence?: number }[];
  fullTextAnnotation?: { text?: string };
  error?: { code?: number };
};

// ---------- signal derivation (11 Implementation guide table) ----------

// Vision likelihoods as ordinals 0..4; UNKNOWN and absent count as 0.
const LIKELIHOOD: Readonly<Record<string, number>> = {
  VERY_UNLIKELY: 0,
  UNLIKELY: 1,
  POSSIBLE: 2,
  LIKELY: 3,
  VERY_LIKELY: 4,
};
const LIKELY = 3;
const ordinal = (v: string | undefined): number => (v !== undefined ? LIKELIHOOD[v] ?? 0 : 0);

const CONTACT: readonly RegExp[] = [
  /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/, // phone
  /(?<!\d)\d{3}[\s.-]\d{4}(?!\d)/, // local phone
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // email
  /(?:^|[^A-Za-z0-9_@.])@[A-Za-z0-9_.]{2,30}/, // @handle
  /\bsnap(?:chat)?\s*[:@]/i,
  /\b(?:ig|insta(?:gram)?)\s*[:@]/i,
  /\b(?:https?:\/\/|www\.)\S+/i, // URL
  /\b[a-z0-9-]{2,}\.(?:com|net|org|io|me|co|us|edu|gg|ly|app|tv|xyz|info|biz)\b/i, // bare domain
];

// Capitalized words common on objects and labels, or at sentence starts (advisory signal only).
const NAME_STOPWORDS = new Set(
  (
    'the a an and or of in on at to for with by from my your our his her their this that these those is are was be it if ' +
    'no not yes do please return thank thanks you property name class grade room school high middle elementary team club ' +
    'made china usa new york north south east west face water bottle hydro flask stanley nike adidas apple samsung iphone ' +
    'ipad airpods jansport puma under armour vans converse crocs champion gap old navy disney lego pokemon marvel super mario ' +
    'hello kitty best love happy birthday merry christmas math science history english spanish art music library book ' +
    'notebook homework lunch box keep out caution warning only one size small medium large extra big little life good great ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday'
  ).split(' '),
);
const CAPITALIZED = /^\p{Lu}\p{Ll}+(?:[-'’]\p{Lu}?\p{Ll}+)*$/u;

function nameLike(text: string): boolean {
  const tokens = text.split(/\s+/).map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (CAPITALIZED.test(a) && CAPITALIZED.test(b) && !NAME_STOPWORDS.has(a.toLowerCase()) && !NAME_STOPWORDS.has(b.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function deriveSignals(r: AnnotateResponse): Signals {
  const ss = r.safeSearchAnnotation ?? {};
  const nsfwScore = Math.max(ordinal(ss.adult), ordinal(ss.racy), ordinal(ss.violence));
  const faceCount = (r.faceAnnotations ?? []).filter((f) => typeof f.detectionConfidence === 'number' && f.detectionConfidence >= 0.6).length;
  const text = (r.fullTextAnnotation?.text ?? '').replace(/\s+/g, ' ').trim();
  const textChars = [...text].length;
  return {
    nsfw: nsfwScore >= LIKELY,
    nsfw_score: nsfwScore,
    has_face: faceCount >= 1,
    face_count: faceCount,
    has_text: textChars >= 8,
    text_char_count: textChars,
    contact_info: text.length > 0 && CONTACT.some((re) => re.test(text)),
    name_like: text.length > 0 && nameLike(text),
    // G-24: severe is adult or violence at VERY_LIKELY; racy never is.
    severe: ss.adult === 'VERY_LIKELY' || ss.violence === 'VERY_LIKELY',
  };
}

// ---------- providers ----------

const CLEAN: Signals = {
  nsfw: false,
  nsfw_score: 0,
  has_face: false,
  face_count: 0,
  has_text: false,
  text_char_count: 0,
  contact_info: false,
  name_like: false,
  severe: false,
};

// F-73/F-91: providers receive canonical bytes only; the mock proves it on every call.
function assertCanonical(jpeg: Buffer): void {
  if (sniff(jpeg) !== 'jpeg' || hasMetadataSegments(jpeg)) throw new PermanentError('not_canonical');
}

export type VisionDeps = {
  mode: VisionMode;
  mockFlag?: boolean;
  oidcToken?: string | null; // Vercel OIDC token: request header x-vercel-oidc-token, else VERCEL_OIDC_TOKEN
  gcp?: { wifAudience: string; serviceAccountEmail: string } | null;
  fetch?: FetchLike;
  now?: () => number;
};

export function createVision(d: VisionDeps): Vision {
  if (d.mode === 'off') {
    return { mode: 'off', provider: 'none', model: 'none', screen: async () => null };
  }
  if (d.mode === 'mock') {
    const flag = d.mockFlag === true;
    return {
      mode: 'mock',
      provider: 'mock',
      model: 'mock-1',
      async screen(jpeg) {
        assertCanonical(jpeg);
        return { provider: 'mock', model: 'mock-1', status: 'ok', signals: { ...CLEAN, has_text: flag, text_char_count: flag ? 12 : 0 } };
      },
    };
  }
  const gcp = d.gcp ?? null;
  const fetchImpl = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  return {
    mode: 'google',
    provider: 'google_vision',
    model: 'v1',
    async screen(jpeg) {
      assertCanonical(jpeg);
      // Missing WIF settings: retried, then recorded as a screening error on the last attempt.
      if (!gcp) throw new RetryableError('provider_config', 300);
      const token = await accessToken(gcp, d.oidcToken ?? null, fetchImpl, now);
      const r = await annotate(jpeg, token, fetchImpl);
      return { provider: 'google_vision', model: 'v1', ...outcomeOf(r) };
    },
  };
}

// ---------- Google: Workload Identity Federation token (F-92: no stored key) ----------

type CachedToken = { cacheKey: string; token: string; expiresAtMs: number };
let cached: CachedToken | undefined;

export function clearTokenCache(): void {
  cached = undefined;
}

async function postJson(fetchImpl: FetchLike, url: string, body: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new RetryableError('provider_auth_unavailable', 30);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new RetryableError(res.status >= 500 || res.status === 429 ? 'provider_auth_unavailable' : 'provider_auth', 60);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') throw new RetryableError('provider_auth', 60);
  return parsed as Record<string, unknown>;
}

async function accessToken(
  gcp: { wifAudience: string; serviceAccountEmail: string },
  oidcToken: string | null,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<string> {
  const cacheKey = `${gcp.wifAudience}|${gcp.serviceAccountEmail}`;
  // Reuse until 5 minutes before expiry (11 Implementation guide).
  if (cached && cached.cacheKey === cacheKey && cached.expiresAtMs - 300_000 > now()) return cached.token;
  if (!oidcToken) throw new RetryableError('provider_auth', 60);
  if (/[\s/?#]/.test(gcp.serviceAccountEmail)) throw new PermanentError('provider_config');
  const sts = await postJson(fetchImpl, 'https://sts.googleapis.com/v1/token', {
    audience: gcp.wifAudience,
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    subjectToken: oidcToken,
  }, {});
  const federated = typeof sts.access_token === 'string' ? sts.access_token : '';
  if (!federated) throw new RetryableError('provider_auth', 60);
  const sa = await postJson(
    fetchImpl,
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${gcp.serviceAccountEmail}:generateAccessToken`,
    { scope: ['https://www.googleapis.com/auth/cloud-vision'], lifetime: '3600s' },
    { authorization: `Bearer ${federated}` },
  );
  const token = typeof sa.accessToken === 'string' ? sa.accessToken : '';
  const expiresAtMs = typeof sa.expireTime === 'string' ? Date.parse(sa.expireTime) : Number.NaN;
  if (!token || !Number.isFinite(expiresAtMs)) throw new RetryableError('provider_auth', 60);
  cached = { cacheKey, token, expiresAtMs };
  return token;
}

// ---------- Google: images:annotate ----------

const FEATURES = [{ type: 'SAFE_SEARCH_DETECTION' }, { type: 'FACE_DETECTION', maxResults: 5 }, { type: 'TEXT_DETECTION' }];
// google.rpc codes worth another attempt: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE.
const RETRY_RPC = new Set([4, 8, 13, 14]);

async function annotate(jpeg: Buffer, token: string, fetchImpl: FetchLike): Promise<AnnotateResponse> {
  let res: Response;
  try {
    res = await fetchImpl('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: jpeg.toString('base64') }, features: FEATURES }] }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000), // 8 s connect + read
    });
  } catch {
    throw new RetryableError('provider_unavailable', 30);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) {
      cached = undefined;
      throw new RetryableError('provider_auth', 60);
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after') ?? 'NaN');
      throw new RetryableError('provider_unavailable', Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) : 30);
    }
    throw new PermanentError('provider_rejected');
  }
  const body = (await res.json().catch(() => null)) as { responses?: AnnotateResponse[] } | null;
  const first = body?.responses?.[0];
  if (!first) throw new RetryableError('provider_unavailable', 30);
  return first;
}

// Partial results are kept (§10.4): with an error set, whatever annotations came back are valid, and
// each absent one is noted as missing_<feature>. An error with nothing usable is retried or refused.
function outcomeOf(r: AnnotateResponse): { status: 'ok' | 'partial'; signals: Signals } {
  if (!r.error) return { status: 'ok', signals: deriveSignals(r) };
  const missingSafeSearch = r.safeSearchAnnotation === undefined;
  const missingFace = r.faceAnnotations === undefined;
  const missingText = r.fullTextAnnotation === undefined;
  if (missingSafeSearch && missingFace && missingText) {
    if (typeof r.error.code === 'number' && RETRY_RPC.has(r.error.code)) throw new RetryableError('provider_unavailable', 30);
    throw new PermanentError('provider_rejected');
  }
  const signals: Signals = { ...deriveSignals(r) };
  if (missingSafeSearch) signals.missing_safe_search = true;
  if (missingFace) signals.missing_face = true;
  if (missingText) signals.missing_text = true;
  return { status: 'partial', signals };
}
