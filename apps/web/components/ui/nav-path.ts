// Route matching for navigation (shared by the server TopNav and the client NavLink).
// Case-insensitive: school codes reach the app in either case (/s/fchs and /s/FCHS).
export function isCurrentPath(pathname: string, href: string, match: 'exact' | 'prefix' = 'prefix'): boolean {
  const current = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const path = (href.split(/[?#]/)[0] ?? href).toLowerCase().replace(/\/+$/, '') || '/';
  if (match === 'exact') return current === path;
  return current === path || current.startsWith(path === '/' ? '/' : `${path}/`);
}
