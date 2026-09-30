// JSON shapes returned by the SQL function catalog (BUILD-CONTRACT.md section 6).
// SQL returns these keys exactly (camelCase). Student DTOs are allowlisted (§7.5.1):
// adding a key is a privacy review, and tests/unit/dto_allowlist.test.mjs pins the key sets.

export type Category =
  | 'bag' | 'clothing' | 'bottle' | 'book' | 'electronics_low' | 'jewelry' | 'sports' | 'other'
  | 'phone' | 'wallet' | 'keys' | 'id_card' | 'medication';

export const HIGH_VALUE_CATEGORIES: readonly Category[] = ['phone', 'wallet', 'keys', 'id_card', 'medication'];
export const STUDENT_CATEGORIES: readonly Category[] = ['bag', 'clothing', 'bottle', 'book', 'electronics_low', 'jewelry', 'sports', 'other'];

export type ReviewStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type PublicationStatus = 'hidden' | 'generating' | 'published' | 'withdrawn';
export type Custody = 'with_finder' | 'at_location' | 'claimed' | 'expired_donated' | 'expired_disposed' | 'expired_never_arrived';
export type StaffRole = 'reviewer' | 'office' | 'school_admin' | 'district_admin';
export type RejectReason = 'inappropriate' | 'not_an_item' | 'duplicate' | 'pii_visible' | 'spam' | 'other';
export type ReportStatus = 'open' | 'closed_found' | 'closed_by_user' | 'closed_by_staff' | 'expired';

// ---------- public / student ----------

export type PublicPhotoRow = { position: 0 | 1 | 2; thumbPath: string; mediumPath: string; width: number; height: number };

export type PublicItemRow = {
  id: string;
  publicId: string;
  category: Category;
  description: string;
  zoneName: string | null;
  custody: 'with_finder' | 'at_location';
  foundAt: string;
  receivedAt: string | null;
  locationId: string;
  rowVersion: number;
  photos: PublicPhotoRow[];
};

// Client-facing form: storage keys replaced by absolute public URLs by the web layer.
export type PublicPhoto = { position: 0 | 1 | 2; thumbUrl: string; mediumUrl: string; width: number; height: number };
export type PublicItem = Omit<PublicItemRow, 'photos'> & { photos: PublicPhoto[] };

export type ListingRow = PublicItemRow & { location: { id: string; name: string; hours: string | null } };

export type Meta = {
  school: {
    id: string;
    code: string;
    name: string;
    timezone: string;
    flags: { studentPosting: boolean; lostReports: boolean; crossSchoolSearch: boolean };
    enabledCategories: Category[];
  };
  map: { versionId: string; path: string; width: number; height: number } | null;
  locations: { id: string; code: string; name: string; hours: string | null; pin: { x: number; y: number } | null }[];
  zones: { id: string; name: string; cx: number; cy: number; radius: number }[];
};

export type FeedPage = { items: PublicItemRow[]; nextCursor: { createdAt: string; id: string } | null };

export type DraftCreated = { itemId: string; photos: { photoId: string; position: number; generation: number }[] };
export type UploadSpec = { photoId: string; position: number; url: string; expiresAt: string };
export type CompleteCheckObject = { photoId: string; exists: boolean; rawBytes: number | null; magicOk: boolean };
export type Completed = { itemId: string; publicId: string; reviewStatus: 'pending'; arrivalDeadlineAt: string | null };

export type ItemStatus = {
  itemId: string;
  publicId: string | null;
  reviewStatus: ReviewStatus;
  publicationStatus: PublicationStatus;
  custody: Custody;
  arrivalDeadlineAt: string | null;
};

export type MyItem = {
  itemId: string;
  publicId: string | null;
  category: Category;
  createdAt: string;
  reviewStatus: ReviewStatus;
  publicationStatus: PublicationStatus;
  custody: Custody;
};

export type MyLostReportMatch = {
  itemId: string;
  publicId: string;
  category: Category;
  description: string;
  score: number;
  custody: 'with_finder' | 'at_location';
  locationId: string;
  thumbPath: string | null;
};

export type MyLostReport = {
  id: string;
  category: Category | null;
  description: string;
  status: 'open';
  matchCount: number;
  lastMatchedAt: string | null;
  lastViewedAt: string | null;
  expiresAt: string;
  rowVersion: number;
  matches: MyLostReportMatch[];
};

// ---------- staff ----------

export type Membership = {
  memberId: string;
  schoolId: string | null;
  schoolCode: string | null;
  schoolName: string | null;
  role: StaffRole;
  status: 'invited' | 'active' | 'deactivated';
};

export type StaffSession = {
  user: { id: string; email: string; displayName: string | null };
  memberships: Membership[];
};

export type StaffItemRow = {
  id: string;
  publicId: string | null;
  category: Category;
  description: string | null;
  note: string | null;
  pin: { x: number; y: number } | null;
  mapVersionId: string | null;
  zoneId: string | null;
  zoneName: string | null;
  dropoffLocationId: string;
  currentLocationId: string | null;
  reviewStatus: ReviewStatus;
  publicationStatus: PublicationStatus;
  custody: Custody;
  postedByKind: 'student' | 'staff' | 'backfill';
  createdAt: string;
  arrivalDeadlineAt: string | null;
  expiresAt: string | null;
  dispositionDueAt: string | null;
  rowVersion: number;
  screeningStatus: 'unscreened' | 'clean' | 'flagged' | 'error';
  flags: string[];
  quarantine: boolean;
  photos: { photoId: string; position: number; generation: number; status: string; isCurrent: boolean }[];
  deviceRejections30d: number | null;
};

export type ItemTransitionResult = {
  itemId: string;
  reviewStatus: ReviewStatus;
  publicationStatus: PublicationStatus;
  custody: Custody;
  rowVersion: number;
};

// ---------- staff assertion (BUILD-CONTRACT.md section 5) ----------

export type AssertionBundle = {
  v: 'v1';
  request_id: string;
  google_sub: string;
  scope: string;
  operation: string;
  target_id: string | null;
  row_version: number | null;
  body_sha256: string;
  idempotency_key_sha256: string | null;
  key_version: number;
  iat: number;
  exp: number;
  mac: string;
};

// ---------- worker ----------

export type LeasedJob = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  schoolId: string | null;
  attempts: number;
  maxAttempts: number;
};
