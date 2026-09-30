// Chips: compact labels and filters.
// - Chip: static label (reason chips, tags).
// - ChipLink: a filter that is a link (server-friendly); `selected` sets aria-current and a check.
// - ChipButton: a toggle inside client components; `pressed` sets aria-pressed and a check.
// - ChipGroup: labels a set of chips for assistive technology.
import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconCheck } from './icons.tsx';

type Size = 'sm' | 'md';

export type ChipProps = HTMLAttributes<HTMLSpanElement> & { icon?: ReactNode; size?: Size; tone?: 'neutral' | 'flag' };

export function Chip({ icon, size = 'md', tone = 'neutral', className, children, ...rest }: ChipProps) {
  return (
    <span className={cx('chip', size === 'sm' && 'chip-sm', tone === 'flag' && 'chip-flag', className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}

export type ChipLinkProps = Omit<ComponentProps<typeof Link>, 'className'> & {
  selected?: boolean;
  icon?: ReactNode;
  size?: Size;
  className?: string;
};

export function ChipLink({ selected = false, icon, size = 'md', className, children, ...rest }: ChipLinkProps) {
  return (
    <Link className={cx('chip', size === 'sm' && 'chip-sm', className)} aria-current={selected ? 'true' : undefined} {...rest}>
      {selected ? <IconCheck size={16} /> : icon}
      {children}
    </Link>
  );
}

export type ChipButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean; icon?: ReactNode; size?: Size };

export function ChipButton({ pressed, icon, size = 'md', className, children, type = 'button', ...rest }: ChipButtonProps) {
  return (
    <button type={type} className={cx('chip', size === 'sm' && 'chip-sm', className)} aria-pressed={pressed} {...rest}>
      {pressed ? <IconCheck size={16} /> : icon}
      {children}
    </button>
  );
}

export function ChipGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className={cx('chips', className)}>
      {children}
    </div>
  );
}
