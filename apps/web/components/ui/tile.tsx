// Tiles: large icon targets (at least 100px tall) for the category step and similar pickers.
// - TileLink: navigates (server-friendly), for example one tile per category.
// - TileButton: an action or toggle inside client components (`pressed` sets aria-pressed).
// - TileRadio: a real radio input styled as a tile, for forms that submit a choice.
// Wrap tiles in <ul className="tile-grid"> (links, buttons) or a Fieldset (radios).
import Link from 'next/link';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconCheck } from './icons.tsx';

type TileLook = { icon?: ReactNode; label: ReactNode; description?: ReactNode; accent?: boolean };

function TileInner({ icon, label, description, withCheck }: TileLook & { withCheck?: boolean }) {
  return (
    <>
      {icon ? (
        <span className="tile-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>
        <span className="tile-label">{label}</span>
        {description ? (
          <>
            <br />
            <span className="tile-desc">{description}</span>
          </>
        ) : null}
      </span>
      {withCheck ? <IconCheck className="tile-check" size={20} /> : null}
    </>
  );
}

export function TileLink({ href, className, accent, ...look }: TileLook & { href: string; className?: string }) {
  return (
    <Link href={href} className={cx('tile', accent && 'tile-tone-accent', className)}>
      <TileInner {...look} />
    </Link>
  );
}

export function TileButton({
  icon,
  label,
  description,
  accent,
  pressed,
  className,
  type = 'button',
  ...rest
}: TileLook & { pressed?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button type={type} className={cx('tile', accent && 'tile-tone-accent', className)} aria-pressed={pressed} {...rest}>
      <TileInner icon={icon} label={label} description={description} withCheck={pressed !== undefined} />
    </button>
  );
}

export function TileRadio({
  icon,
  label,
  description,
  accent,
  className,
  ...input
}: TileLook & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & { name: string; value: string }) {
  return (
    <label className={cx('tile-choice', className)}>
      <input type="radio" className="tile-input" {...input} />
      <span className={cx('tile', accent && 'tile-tone-accent')}>
        <TileInner icon={icon} label={label} description={description} withCheck />
      </span>
    </label>
  );
}
