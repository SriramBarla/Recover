// Result shapes of the system_* functions the worker calls (BUILD-CONTRACT.md section 6.4), plus the
// two the contract leaves open (system_screening_targets, system_map_get), stated as the worker reads
// them. Candidates for packages/shared/src/dto.ts once the SQL side settles.

export type PhotoStatus = 'uploaded' | 'canonicalizing' | 'canonical_ready' | 'public_ready' | 'failed' | 'deleted';

export type PhotoRow = {
  photoId: string;
  itemId: string;
  schoolId: string;
  status: PhotoStatus;
  incomingPath: string | null;
  originalPath: string | null;
  reviewPath: string | null;
  thumbPath: string | null;
  mediumPath: string | null;
  publicObjectToken: string | null;
  isCurrent: boolean;
};

export type UploadSpecRow = { schoolId: string; itemId: string; photos: { photoId: string; position: number; key: string }[] };

export type CompleteSpecRow = { photos: { photoId: string; key: string }[] };

export type TicketContext = {
  schoolId: string;
  operation: string;
  itemId?: string | null;
  photoId: string | null;
  reviewPath: string | null;
  originalPath: string | null;
  mapVersionId: string | null;
  draftPath: string | null;
  draftCanonicalPath: string | null;
  publicPath?: string | null;
};

export type DeletionObject = {
  photoId: string;
  objectKind: string;
  bucket: string;
  storagePath: string | null; // NULLed by the deletion_evidence purge 90 days after verification
  deletedAt: string | null;
  verifiedAt: string | null;
};

// `found: false` means the ledger was cancelled (a late arrival, G-01): nothing to delete.
export type DeletionLedger = { found?: boolean; schoolId?: string; itemId?: string; objects?: DeletionObject[] };

export type VariantTarget = { photoId: string; originalPath: string; token: string; status?: PhotoStatus };

// Requested: system_screening_targets(p_item_id, p_policy_version) -> current canonical photos of the
// item that have no screening run for that policy yet.
export type ScreeningTarget = { photoId: string; originalPath: string };

// system_map_get(p_map_version_id); the contract names the function only.
export type MapRow = {
  mapVersionId: string;
  schoolId: string;
  approvalStatus: string;
  draftPath: string | null;
  draftCanonicalPath: string | null;
  publicPath?: string | null;
};

export type DraftToPurge = { itemId: string; schoolId: string; incomingPaths: string[] };

// system_match_candidates_for_item / _for_report pairs, exactly as the shared scorer takes them.
export type { MatchPair } from '@recover/shared/matcher.ts';
