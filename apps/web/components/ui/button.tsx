// Button and LinkButton. Shared (server-safe) components: no hooks, no handlers of their own,
// so they render from server components and accept onClick when used inside client components.
import Link from 'next/link';
import type { ComponentProps, ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from './cx.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Look = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  // Icon-only buttons need an aria-label; the visible label is omitted.
  iconOnly?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  'danger-outline': 'btn-danger-outline',
};

export function buttonClass(o: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; iconOnly?: boolean; className?: string }): string {
  return cx(
    'btn',
    VARIANT[o.variant ?? 'secondary'],
    o.size === 'sm' && 'btn-sm',
    o.size === 'lg' && 'btn-lg',
    o.block && 'btn-block',
    o.iconOnly && 'btn-icon',
    o.className,
  );
}

export type ButtonProps = Look &
  ComponentPropsWithRef<'button'> & {
    // Keeps the button focusable, shows a spinner, and sets aria-busy/aria-disabled.
    // Your handler must ignore presses while loading (keyboard presses still fire click).
    loading?: boolean;
    loadingText?: ReactNode;
  };

export function Button({
  variant,
  size,
  block,
  iconOnly,
  icon,
  iconEnd,
  loading = false,
  loadingText,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass({ variant, size, block, iconOnly, className })}
      aria-busy={loading ? true : undefined}
      aria-disabled={loading ? true : rest['aria-disabled']}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : icon}
      {iconOnly ? null : <span className="btn-label">{loading && loadingText ? loadingText : children}</span>}
      {loading ? null : iconEnd}
    </button>
  );
}

export type LinkButtonProps = Look & Omit<ComponentProps<typeof Link>, 'className'> & { className?: string };

export function LinkButton({ variant, size, block, iconOnly, icon, iconEnd, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link className={buttonClass({ variant, size, block, iconOnly, className })} {...rest}>
      {icon}
      {iconOnly ? null : <span className="btn-label">{children}</span>}
      {iconEnd}
    </Link>
  );
}
