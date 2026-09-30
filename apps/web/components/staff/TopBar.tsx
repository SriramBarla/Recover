import type { ReactNode } from 'react';
import { signOutAction } from './actions.ts';

type Props = { brandHref: string; context?: string | null; nav?: ReactNode; userLabel?: string | null; links?: ReactNode };

// Staff and district header: brand, current school or area, section nav, user, and sign out.
export function TopBar({ brandHref, context, nav, userLabel, links }: Props) {
  return (
    <header className="topbar">
      <div className="container" style={{ flexWrap: 'wrap' }}>
        <div className="row">
          <a className="brand" href={brandHref}>
            Recover
          </a>
          {context ? <span className="badge badge-brand">{context}</span> : null}
        </div>
        {nav}
        <div className="row small">
          {links}
          {userLabel ? <span className="muted">{userLabel}</span> : null}
          <form action={signOutAction}>
            <button type="submit" className="btn btn-ghost">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
