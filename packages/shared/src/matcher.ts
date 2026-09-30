// Lost-report matching scorer (§12.2; 12 Implementation guide "Matching scorer"). Deterministic and
// versioned: weights and threshold are constants of SCORER_VERSION. A pair is a match when
// score >= THRESHOLD. Pairs come from system_match_candidates_for_item / _for_report (contract 6.4).
export const SCORER_VERSION = 'v1';
export const WEIGHTS = { lex: 0.45, cat: 0.2, time: 0.15, loc: 0.2 } as const;
export const THRESHOLD = 0.55;

export type MatchPair = {
  reportId: string;
  itemId: string;
  lex: number; // max(normalized FTS rank, trigram similarity), computed in SQL
  sameCategory: boolean;
  reportCategoryNull: boolean;
  foundAt: string; // item found_at, ISO timestamp
  lostOn: string | null; // report lost_on, YYYY-MM-DD
  sameMapVersion: boolean;
  dx: number | null; // item pin minus report pin in normalized map units; null when either pin is null
  dy: number | null;
  mapWidth: number | null; // pixel size of the shared map version
  mapHeight: number | null;
};

export type MatchFeatures = { lex: number; cat: number; time: number; loc: number };
export type MatchScore = { score: number; features: MatchFeatures };

const DAY_MS = 86_400_000;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

// 1 same category, 0.5 when the report has no category, else 0.
function catFeature(p: MatchPair): number {
  return p.sameCategory ? 1 : p.reportCategoryNull ? 0.5 : 0;
}

// Gap in days from the start of lost_on (UTC) to found_at: 1 up to 3 days after (and when found at
// most 1 day before, which absorbs date and timezone rounding), linear to 0 at 21 days, 0.25 when
// found more than 1 day before the loss, 0.5 when lost_on is unknown.
function timeFeature(p: MatchPair): number {
  if (p.lostOn === null) return 0.5;
  const lost = Date.parse(p.lostOn);
  const found = Date.parse(p.foundAt);
  if (Number.isNaN(lost) || Number.isNaN(found)) return 0.5;
  const gap = (found - lost) / DAY_MS;
  if (gap < -1) return 0.25;
  if (gap <= 3) return 1;
  if (gap >= 21) return 0;
  return (21 - gap) / 18;
}

// Map distance only on the same map version, scaled so a unit is a unit: d = |(dx*w, dy*h)| / max(w, h).
// 1 at d <= 0.05, linear to 0 at d >= 0.25, 0.5 when either pin is missing or the versions differ.
function locFeature(p: MatchPair): number {
  const { dx, dy, mapWidth: w, mapHeight: h } = p;
  if (!p.sameMapVersion || !finite(dx) || !finite(dy) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return 0.5;
  const d = Math.hypot(dx * w, dy * h) / Math.max(w, h);
  if (d <= 0.05) return 1;
  if (d >= 0.25) return 0;
  return (0.25 - d) / 0.2;
}

// Features are rounded to 6 decimals and the score is computed from the rounded features, so the
// stored features always reproduce the stored score (explainability, §12.2 step 6).
export function score(pair: MatchPair): MatchScore {
  const features: MatchFeatures = {
    lex: round6(finite(pair.lex) ? Math.min(1, Math.max(0, pair.lex)) : 0),
    cat: catFeature(pair),
    time: round6(timeFeature(pair)),
    loc: round6(locFeature(pair)),
  };
  const s = WEIGHTS.lex * features.lex + WEIGHTS.cat * features.cat + WEIGHTS.time * features.time + WEIGHTS.loc * features.loc;
  return { score: round6(s), features };
}
