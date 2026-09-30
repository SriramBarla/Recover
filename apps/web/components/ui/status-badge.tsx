// StatusBadge: one vocabulary for every state machine in Recover (§6), each state with an icon
// and words, never color alone. `context` adds a spoken prefix ("Review: Approved") for places
// without a column header. FlagChip names the queue's screening flags in plain words; flagKeys
// derives the flags a card shows from a StaffItemRow's flags and screeningStatus.
import type { ReactNode } from 'react';
import { badgeClass, type Tone } from './badge.tsx';
import {
  IconAlert,
  IconBuilding,
  IconCheck,
  IconClock,
  IconEyeOff,
  IconFlag,
  IconGift,
  IconGlobe,
  IconLock,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconTrash,
  IconUser,
  IconX,
  type IconComponent,
} from './icons.tsx';

export type StatusKind = 'review' | 'publication' | 'custody' | 'report' | 'map' | 'member' | 'screening';

type Def = { label: string; tone: Tone; Icon: IconComponent };

const DEFS: Record<StatusKind, Record<string, Def>> = {
  review: {
    draft: { label: 'Draft', tone: 'neutral', Icon: IconPencil },
    pending: { label: 'Needs review', tone: 'warn', Icon: IconClock },
    approved: { label: 'Approved', tone: 'ok', Icon: IconCheck },
    rejected: { label: 'Rejected', tone: 'danger', Icon: IconX },
  },
  publication: {
    hidden: { label: 'Not public', tone: 'neutral', Icon: IconLock },
    generating: { label: 'Publishing', tone: 'info', Icon: IconRefresh },
    published: { label: 'Public', tone: 'brand', Icon: IconGlobe },
    withdrawn: { label: 'Withdrawn', tone: 'neutral', Icon: IconEyeOff },
  },
  custody: {
    with_finder: { label: 'With finder', tone: 'warn', Icon: IconUser },
    at_location: { label: 'In custody', tone: 'brand', Icon: IconBuilding },
    claimed: { label: 'Claimed', tone: 'ok', Icon: IconCheck },
    expired_donated: { label: 'Donated', tone: 'neutral', Icon: IconGift },
    expired_disposed: { label: 'Disposed', tone: 'neutral', Icon: IconTrash },
    expired_never_arrived: { label: 'Never arrived', tone: 'danger', Icon: IconAlert },
  },
  report: {
    open: { label: 'Open', tone: 'brand', Icon: IconSearch },
    closed_found: { label: 'Found', tone: 'ok', Icon: IconCheck },
    closed_by_user: { label: 'Closed', tone: 'neutral', Icon: IconX },
    closed_by_staff: { label: 'Closed by staff', tone: 'neutral', Icon: IconX },
    expired: { label: 'Expired', tone: 'neutral', Icon: IconClock },
  },
  map: {
    draft: { label: 'Draft', tone: 'neutral', Icon: IconPencil },
    pending_district: { label: 'Awaiting district', tone: 'warn', Icon: IconClock },
    approved: { label: 'Approved', tone: 'ok', Icon: IconCheck },
    rejected: { label: 'Rejected', tone: 'danger', Icon: IconX },
    retired: { label: 'Retired', tone: 'neutral', Icon: IconEyeOff },
  },
  member: {
    invited: { label: 'Invited', tone: 'warn', Icon: IconClock },
    active: { label: 'Active', tone: 'ok', Icon: IconCheck },
    deactivated: { label: 'Deactivated', tone: 'neutral', Icon: IconX },
  },
  screening: {
    unscreened: { label: 'Not screened', tone: 'neutral', Icon: IconClock },
    clean: { label: 'Screened', tone: 'ok', Icon: IconShieldCheck },
    flagged: { label: 'Flagged', tone: 'danger', Icon: IconFlag },
    error: { label: 'Screening error', tone: 'warn', Icon: IconAlert },
  },
};

const KIND_LABEL: Record<StatusKind, string> = {
  review: 'Review',
  publication: 'Publication',
  custody: 'Custody',
  report: 'Report',
  map: 'Map',
  member: 'Account',
  screening: 'Screening',
};

function humanize(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function statusLabel(kind: StatusKind, status: string): string {
  return DEFS[kind][status]?.label ?? humanize(status);
}

export function StatusBadge({
  kind,
  status,
  label,
  context = false,
  size = 'md',
  className,
}: {
  kind: StatusKind;
  status: string;
  // Overrides the words, for example "At West Campus" for custody.
  label?: ReactNode;
  context?: boolean;
  size?: 'md' | 'lg';
  className?: string;
}) {
  const def = DEFS[kind][status];
  const Icon = def?.Icon ?? IconClock;
  return (
    <span className={badgeClass(def?.tone ?? 'neutral', size, className)} data-status={status}>
      <Icon size={size === 'lg' ? 16 : 14} />
      {context ? <span className="visually-hidden">{KIND_LABEL[kind]}: </span> : null}
      {label ?? def?.label ?? humanize(status)}
    </span>
  );
}

// Review-queue flags (§5.3 step 2), in the staff app's words. Unknown flags render neutral.
export const FLAGS: Record<string, { label: string; tone: Tone }> = {
  nsfw: { label: 'Possible explicit content', tone: 'danger' },
  has_face: { label: 'Face visible', tone: 'warn' },
  has_text: { label: 'Text visible', tone: 'warn' },
  contact_info: { label: 'Contact info', tone: 'danger' },
  duplicate: { label: 'Possible duplicate', tone: 'warn' },
  repeat_device: { label: 'Repeat device', tone: 'warn' },
  screening_error: { label: 'Screening failed', tone: 'warn' },
  ceiling: { label: 'Not screened (daily limit)', tone: 'warn' },
  unscreened: { label: 'Screening pending', tone: 'neutral' },
  hold: { label: 'Held for confirmation', tone: 'warn' },
};

// The flags a queue card shows: the row's flags (minus quarantine, which has its own banner) plus
// the ones implied by screeningStatus.
export function flagKeys(flags: readonly string[], screeningStatus?: string | null): string[] {
  const keys = flags.filter((f) => f !== 'quarantine');
  if (screeningStatus === 'unscreened' && !keys.includes('unscreened')) keys.push('unscreened');
  if (screeningStatus === 'error' && !keys.includes('screening_error') && !keys.includes('ceiling')) keys.push('screening_error');
  return keys;
}

export function FlagChip({ flag, size = 'md', className }: { flag: string; size?: 'md' | 'lg'; className?: string }) {
  const def = FLAGS[flag];
  const tone = def?.tone ?? 'neutral';
  const Icon = tone === 'danger' ? IconAlert : tone === 'neutral' ? IconClock : IconFlag;
  return (
    <span className={badgeClass(tone, size, className)} data-flag={flag}>
      <Icon size={size === 'lg' ? 16 : 14} />
      {def?.label ?? humanize(flag)}
    </span>
  );
}
