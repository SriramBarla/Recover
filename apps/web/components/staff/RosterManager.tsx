'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { StaffRole } from '@recover/shared/dto.ts';
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
      <section className="card stack" aria-labelledby="invite-h">
        <h2 id="invite-h">Invite staff</h2>
        <form onSubmit={invite} className="stack">
          <div className="grid">
            <label className="field">
              <span className="label">District email</span>
              <input className="input" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Name (optional)</span>
              <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Role</span>
              <select className="select" value={role} onChange={(e) => setRole(e.target.value as Assignable)}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Inviting...' : 'Invite'}
          </button>
          <ActionError error={error} />
        </form>
        {invited ? (
          <div className="notice notice-ok stack" role="status">
            <p style={{ margin: 0 }}>
              Invited {invited}. Recover does not send email: share this sign-in link with them.
            </p>
            <div className="row">
              <input className="input mono" readOnly value={link} aria-label="Sign-in link" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: '16rem' }} />
              <CopyButton text={link} />
            </div>
          </div>
        ) : null}
        <p className="hint">Reviewers review posts. Office staff also handle custody and devices. School admins also manage the roster, locations, map, and settings.</p>
      </section>

      <section className="stack" aria-labelledby="roster-h">
        <h2 id="roster-h">Staff at {code}</h2>
        {members.length === 0 ? (
          <p className="muted">No staff yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
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
            </table>
          </div>
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
      <td className="small">{m.lastLoginAt ? fmtDateTime(m.lastLoginAt, tz) : m.status === 'invited' ? <span className="badge">Invited</span> : 'Never'}</td>
      <td>
        {editable ? (
          <div className="stack">
            <div className="row">
              <label className="field">
                <span className="visually-hidden">Role</span>
                <select className="select" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="visually-hidden">Status</span>
                <select className="select" value={status} onChange={(e) => setStatus(e.target.value as (typeof MEMBER_STATUSES)[number])}>
                  <option value="active">Active</option>
                  <option value="deactivated">Deactivated</option>
                </select>
              </label>
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
          <span>{m.role ? ROLE_LABELS[m.role] : 'Unknown'}</span>
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
    <button
      type="button"
      className="btn"
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
    </button>
  );
}
