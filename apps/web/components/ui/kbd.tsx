// Kbd: a keyboard key, for shortcut hints next to the buttons that do the same thing
// (review shortcuts always have a visible, clickable control too; Appendix H). Inside a button,
// pass aria-hidden so the key does not become part of the button's name.
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';

export function Kbd({ children, label, className, ...rest }: HTMLAttributes<HTMLElement> & { children: ReactNode; label?: string }) {
  return (
    <kbd className={cx('kbd', className)} aria-label={label} {...rest}>
      {children}
    </kbd>
  );
}
