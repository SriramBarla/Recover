// Kbd: a keyboard key, for shortcut hints next to the buttons that do the same thing
// (review shortcuts always have a visible, clickable control too; Appendix H).
import type { ReactNode } from 'react';

export function Kbd({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <kbd className="kbd" aria-label={label}>
      {children}
    </kbd>
  );
}
