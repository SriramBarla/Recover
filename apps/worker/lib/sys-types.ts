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
  photoId: string | null;
  reviewPath: string | null;
  originalPath: string | null;
  mapVersionId: string | null;
  draftPath: string | null;
  draftCanonicalPath: string | null;
};

export type DeletionObject = {
  photoId: string;
  objectKind: string;
  bucket: string;
  storagePath: string;
  deletedAt: string | null;
  verifiedAt: string | null;
};

export type VariantTarget = { photoId: string; originalPath: string; token: string };

// Requested: system_screening_targets(p_item_id, p_policy_version) -> current canonical photos of the
// item that have no screening run for that policy yet.
export type ScreeningTarget = { photoId: string; originalPath: string };

// Requested shape for system_map_get(p_map_version_id); the contract names the function only.
export type MapRow = {
  mapVersionId: string;
  schoolId: string;
  approvalStatus: string;
  draftPath: string | null;
  draftCanonicalPath: string | null;
};

export type DraftToPurge = { itemId: string; schoolId: string; incomingPaths: string[] };

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
