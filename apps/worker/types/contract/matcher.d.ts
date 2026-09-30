// Type-check stand-in for packages/shared/src/matcher.ts (A-shared), the BUILD-CONTRACT.md section 11
// API over the section 6.4 candidate pair. tsconfig `paths` lists the real file first, so once it
// exists this stub is never resolved. Delete this file after the merge.

export type MatchPair = {
  reportId: string;
  itemId: string;
  lex: number;
  sameCategory: boolean;
  reportCategoryNull: boolean;
  foundAt: string | null;
  lostOn: string | null;
  sameMapVersion: boolean;
  dx: number | null;
  dy: number | null;
  mapWidth: number | null;
  mapHeight: number | null;
};

export declare const SCORER_VERSION: string;
export declare const THRESHOLD: number;
export declare function score(pair: MatchPair): { score: number; features: Record<string, unknown> };
