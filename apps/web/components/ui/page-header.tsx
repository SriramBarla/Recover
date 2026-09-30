// PageHeader: the page's single h1, with an optional back link, eyebrow (for example the school
// name on staff pages), description, and actions. Put it first inside <main id="main">.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconChevronLeft } from './icons.tsx';

export type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: string; prefetch?: boolean };
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
  // Lets a client wizard move focus to the heading on step change.
  titleId?: string;
  focusableTitle?: boolean;
};

export function PageHeader({ title, eyebrow, description, back, actions, className, children, titleId, focusableTitle }: PageHeaderProps) {
  return (
    <header className={cx('page-header', className)}>
      {back ? (
        <Link className="page-header-back" href={back.href} prefetch={back.prefetch}>
          <IconChevronLeft size={18} />
          {back.label}
        </Link>
      ) : null}
      <div className="page-header-row">
        <div className="page-header-text">
          {eyebrow ? <p className="page-header-eyebrow">{eyebrow}</p> : null}
          <h1 id={titleId} tabIndex={focusableTitle ? -1 : undefined}>
            {title}
          </h1>
          {description ? <p className="page-header-desc">{description}</p> : null}
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
