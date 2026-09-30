// Badge: a short label with a tone. Always carries text; color is never the only signal.
// CountBadge: a numeric bubble with a spoken label ("3 new matches").
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';

export type Tone = 'neutral' | 'brand' | 'info' | 'ok' | 'warn' | 'danger' | 'accent';

const TONE: Record<Tone, string> = {
  neutral: 'badge-neutral',
  brand: 'badge-brand',
  info: 'badge-info',
  ok: 'badge-ok',
  warn: 'badge-warn',
  danger: 'badge-danger',
  accent: 'badge-accent',
};

export function badgeClass(tone: Tone = 'neutral', size: 'md' | 'lg' = 'md', className?: string): string {
  return cx('badge', TONE[tone], size === 'lg' && 'badge-lg', className);
}

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  size?: 'md' | 'lg';
  icon?: ReactNode;
};

export function Badge({ tone = 'neutral', size = 'md', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span className={badgeClass(tone, size, className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}

export function CountBadge({ count, label, neutral = false, className }: { count: number; label: string; neutral?: boolean; className?: string }) {
  return (
    <span className={cx('count', neutral && 'count-neutral', className)}>
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="visually-hidden">{`${count} ${label}`}</span>
    </span>
  );
}
