'use client';
// NavLink: sets aria-current="page" from the current pathname, for navs rendered in layouts
// (layouts do not know the active route). Tiny: it only reads usePathname().
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';

export function isCurrentPath(pathname: string, href: string, match: 'exact' | 'prefix' = 'prefix'): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  if (match === 'exact') return pathname === path;
  return pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
}

export function NavLink({ match = 'prefix', ...rest }: ComponentProps<typeof Link> & { match?: 'exact' | 'prefix' }) {
  const pathname = usePathname() ?? '';
  const href = typeof rest.href === 'string' ? rest.href : (rest.href.pathname ?? '');
  const current = isCurrentPath(pathname, href, match);
  return <Link {...rest} aria-current={current ? 'page' : undefined} />;
}
