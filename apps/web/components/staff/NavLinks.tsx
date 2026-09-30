'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export type NavItem = { href: string; label: string; exact?: boolean };

// Top navigation with aria-current on the active section.
export function NavLinks({ items, label }: { items: NavItem[]; label: string }) {
  const path = usePathname() ?? '';
  return (
    <nav className="nav" aria-label={label}>
      {items.map((i) => {
        const current = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={current ? 'page' : undefined}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
