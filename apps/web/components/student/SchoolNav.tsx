'use client';
// Top navigation for one school; marks the current page for assistive technology (aria-current).
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SchoolNav({ code }: { code: string }) {
  const path = (usePathname() ?? '').toUpperCase().replace(/\/+$/, '');
  const links = [
    { href: `/s/${code}`, label: 'Found items' },
    { href: `/s/${code}/lost/mine`, label: 'Your reports' },
    { href: `/s/${code}/mine`, label: 'Your posts' },
  ];
  return (
    <nav className="nav" aria-label="Recover">
      {links.map((l) => (
        <Link key={l.href} href={l.href} prefetch={false} aria-current={path === l.href.toUpperCase() ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
