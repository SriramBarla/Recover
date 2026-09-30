// SubNav: in-page views as links with an underline marker (custody: Expected / In custody /
// Disposition due). Server-friendly; pass `current` (the href of the active view).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountBadge } from './badge.tsx';
import { cx } from './cx.ts';

export type SubNavItem = { href: string; label: string; count?: number; countLabel?: string; icon?: ReactNode };

export function SubNav({ items, current, label, className }: { items: readonly SubNavItem[]; current: string; label: string; className?: string }) {
  return (
    <nav aria-label={label}>
      <ul className={cx('subnav', className)}>
        {items.map((it) => (
          <li key={it.href}>
            <Link href={it.href} aria-current={it.href === current ? 'page' : undefined}>
              {it.icon}
              {it.label}
              {it.count !== undefined ? <CountBadge count={it.count} label={it.countLabel ?? 'items'} neutral /> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
