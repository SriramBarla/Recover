// Route matching for navigation (shared by the server TopNav and the client NavLink).
export function isCurrentPath(pathname: string, href: string, match: 'exact' | 'prefix' = 'prefix'): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  if (match === 'exact') return pathname === path;
  return pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
}
