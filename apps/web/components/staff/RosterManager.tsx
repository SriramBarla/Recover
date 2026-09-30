'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { StaffRole } from '@recover/shared/dto.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconCheck, IconPlus, IconUsers } from '@/components/ui/icons.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { Select } from '@/components/ui/select.tsx';
import { StatusBadge } from '@/components/ui/status-badge.tsx';
import { Table } from '@/components/ui/table.tsx';
import { ActionError } from './ActionError.tsx';
import { staffApi } from './client-api.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { ASSIGNABLE_ROLES, MEMBER_STATUSES } from './constants.ts';
import { ROLE_LABELS, fmtDateTime } from './format.ts';
import type { RosterMember } from './shapes.ts';

type Props = { code: string; members: RosterMember[]; canRebind: boolean; tz: string | null };
type Assignable = (typeof ASSIGNABLE_ROLES)[number];

// Roster (§5.5; §24 step 4): invite by district email, set role, deactivate. Recover sends nothing;
// after an invite the page shows the sign-in link to pass on. Never grants district_admin.
export function RosterManager({ code, members, canRebind, tz }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Assignable>('reviewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invited, setInvited] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => setOrigin(window.location.origin), []);
  const link = `${origin}/staff/signin?callbackUrl=${encodeURIComponent(`/staff/${code}/queue`)}`;

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await staffApi(`/api/staff/${code}/roster`, { body: { email, role, displayName: name.trim() ? name : null } });
      setInvited(email.trim().toLowerCase());
      setEmail('');
      setName('');
      router.refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <section className="card card-pad-lg stack" aria-labelledby="invite-h">
        <h2 id="invite-h" className="with-icon">
          <IconPlus />
          Invite staff
        </h2>
        <p className="hint">Reviewers review posts. Office staff also handle custody and devices. School admins also manage the roster, locations, map, and settings.</p>
        <form onSubmit={invite} className="stack">
          <div className="grid-wide">
            <TextInput id="invite-email" label="District email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextInput id="invite-name" label="Name" optional maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <Select
              id="invite-role"
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as Assignable)}
              options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            />
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={busy} icon={<IconPlus />}>
              {busy ? 'Inviting...' : 'Invite'}
            </Button>
          </div>
          <ActionError error={error} />
        </form>
        {invited ? (
          <Notice tone="success" live="polite">
            <p>Invited {invited}. Recover does not send email: share this sign-in link with them.</p>
            <div className="row">
              <input className="input mono" readOnly value={link} aria-label="Sign-in link" onFocus={(e) => e.currentTarget.select()} style={{ flex: '1 1 16rem', width: 'auto' }} />
              <CopyButton text={link} />
            </div>
          </Notice>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="roster-h">
        <h2 id="roster-h" className="with-icon">
          <IconUsers />
          Staff at {code}
        </h2>
        {members.length === 0 ? (
          <p className="muted">No staff yet.</p>
        ) : (
          <Table caption={`Staff at ${code}`} hideCaption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">Role and status</th>
                {canRebind ? <th scope="col">Google link</th> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={m.memberId} code={code} m={m} canRebind={canRebind} tz={tz} onChanged={() => router.refresh()} />
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

function MemberRow({ code, m, canRebind, tz, onChanged }: { code: string; m: RosterMember; canRebind: boolean; tz: string | null; onChanged: () => void }) {
  const editable = m.role !== null && m.role !== 'district_admin';
  const [role, setRole] = useState<StaffRole>(m.role ?? 'reviewer');
  const [status, setStatus] = useState<(typeof MEMBER_STATUSES)[number]>(m.status === 'deactivated' ? 'deactivated' : 'active');
  const changed = role !== m.role || status !== (m.status === 'deactivated' ? 'deactivated' : 'active');
  return (
    <tr>
      <td>{m.displayName ?? <span className="muted">Not set</span>}</td>
      <td className="mono small">{m.email}</td>
      <td className="small">{m.lastLoginAt ? fmtDateTime(m.lastLoginAt, tz) : m.status === 'invited' ? <StatusBadge kind="member" status="invited" /> : 'Never'}</td>
      <td>
        {editable ? (
          <div className="stack">
            <div className="row">
              <Select
                id={`role-${m.memberId}`}
                label="Role"
                hideLabel
                value={role}
                onChange={(e) => setRole(e.target.value as StaffRole)}
                options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              />
              <Select
                id={`status-${m.memberId}`}
                label="Status"
                hideLabel
                value={status}
                onChange={(e) => setStatus(e.target.value as (typeof MEMBER_STATUSES)[number])}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'deactivated', label: 'Deactivated' },
                ]}
              />
            </div>
            {changed ? (
              <ConfirmButton
                label="Save"
                prompt={status === 'deactivated' ? 'Deactivate this staff member? They lose access on their next request.' : 'Change this role?'}
                confirmLabel="Save change"
                danger={status === 'deactivated'}
                onConfirm={async () => {
                  await staffApi(`/api/staff/${code}/roster/${m.memberId}`, { method: 'PATCH', body: { role, status } });
                  onChanged();
                }}
              />
            ) : null}
          </div>
        ) : (
          <Badge tone="brand">{m.role ? ROLE_LABELS[m.role] : 'Unknown'}</Badge>
        )}
      </td>
      {canRebind ? (
        <td>
          {m.userId ? (
            <ConfirmButton
              label="Reset Google link"
              prompt="Unlink this person's Google account so their invited email can sign in with a new one? This is audited."
              confirmLabel="Reset link"
              danger
              onConfirm={async () => {
                await staffApi(`/api/district/identity/${m.userId}/rebind`, { body: {} });
                onChanged();
              }}
            />
          ) : (
            <span className="muted small">Unavailable</span>
          )}
        </td>
      ) : null}
    </tr>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      icon={copied ? <IconCheck /> : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}
