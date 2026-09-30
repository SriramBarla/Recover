'use client';
// NavLink: sets aria-current="page" from the current pathname, for navs rendered in layouts
// (layouts do not know the active route). Tiny: it only reads usePathname().
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';
import { isCurrentPath } from './nav-path.ts';

export function NavLink({ match = 'prefix', ...rest }: ComponentProps<typeof Link> & { match?: 'exact' | 'prefix' }) {
  const pathname = usePathname() ?? '';
  const href = typeof rest.href === 'string' ? rest.href : (rest.href.pathname ?? '');
  const current = isCurrentPath(pathname, href, match);
  return <Link {...rest} aria-current={current ? 'page' : undefined} />;
}
