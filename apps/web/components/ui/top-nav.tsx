// TopNav: the app bar. Brand (mark + "Recover" + optional context such as the school name), an
// optional context slot (SchoolSwitcher on staff pages), primary links, and an end slot.
// aria-current: pass `currentPath` from a page for static links; omit it in layouts and each
// link resolves the active route itself (NavLink, a tiny client component).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountBadge } from './badge.tsx';
import { cx } from './cx.ts';
import { LogoMark } from './logo.tsx';
import { NavLink } from './nav-link.tsx';
import { isCurrentPath } from './nav-path.ts';

export type NavItem = {
  href: string;
  label: string;
  icon?: ReactNode;
  // Shows a count bubble; countLabel is spoken ("3 waiting for review").
  count?: number;
  countLabel?: string;
  match?: 'exact' | 'prefix';
};

export type TopNavProps = {
  homeHref: string;
  brandContext?: string | null;
  context?: ReactNode;
  items?: readonly NavItem[];
  currentPath?: string;
  navLabel?: string;
  end?: ReactNode;
  className?: string;
};

function Inner({ item }: { item: NavItem }) {
  return (
    <>
      {item.icon}
      <span>{item.label}</span>
      {item.count !== undefined && item.count > 0 ? <CountBadge count={item.count} label={item.countLabel ?? 'new'} /> : null}
    </>
  );
}

export function TopNav({ homeHref, brandContext, context, items, currentPath, navLabel = 'Main', end, className }: TopNavProps) {
  return (
    <header className={cx('topbar', className)}>
      <div className="container">
        <div className="topbar-start">
          <Link className="brand" href={homeHref}>
            <LogoMark />
            <span className="brand-name">Recover</span>
            {brandContext ? <span className="brand-context">{brandContext}</span> : null}
          </Link>
          {context}
        </div>
        {end ? <div className="topbar-end">{end}</div> : null}
        {items && items.length > 0 ? (
          <nav className="topbar-nav" aria-label={navLabel}>
            <ul className="nav">
              {items.map((item) => (
                <li key={item.href}>
                  {currentPath === undefined ? (
                    <NavLink href={item.href} match={item.match}>
                      <Inner item={item} />
                    </NavLink>
                  ) : (
                    <Link href={item.href} aria-current={isCurrentPath(currentPath, item.href, item.match) ? 'page' : undefined}>
                      <Inner item={item} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </header>
  );
}
