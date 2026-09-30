// Enumerations shared by the staff routes (via lib/ops.ts) and client components. Client-safe: no
// Node imports. lib/ops.ts re-exports these so the server has a single source of truth.
import type { Category, RejectReason } from '@recover/shared/dto.ts';

export const ALL_CATEGORIES: readonly Category[] = [
  'bag', 'clothing', 'bottle', 'book', 'electronics_low', 'jewelry', 'sports', 'other',
  'phone', 'wallet', 'keys', 'id_card', 'medication',
];

export const REJECT_REASONS: readonly RejectReason[] = ['inappropriate', 'not_an_item', 'duplicate', 'pii_visible', 'spam', 'other'];

// Reason codes rather than free text, so no free text can reach audit rows (contract section 0).
export const PULL_REASONS = ['pii_visible', 'inappropriate', 'not_an_item', 'duplicate', 'owner_request', 'other'] as const;
export const DELETE_REASONS = ['staff_mistake', 'duplicate', 'test_post', 'other'] as const;
export const BLOCK_REASONS = ['spam', 'inappropriate', 'abuse', 'other'] as const;
export const MAP_REJECT_REASONS = ['safety_review', 'image_quality', 'zones', 'locations', 'other'] as const;
export const DISPOSITIONS = ['donated', 'disposed'] as const;
export const ASSIGNABLE_ROLES = ['reviewer', 'office', 'school_admin'] as const; // never district_admin (§5.5)
export const MEMBER_STATUSES = ['active', 'deactivated'] as const;
export const POST_MODES = ['staff', 'backfill'] as const;
