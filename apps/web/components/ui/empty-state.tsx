// EmptyState: what to show when a list has nothing yet, and what to do next.
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconInbox } from './icons.tsx';

export function EmptyState({
  title,
  children,
  icon,
  actions,
  headingLevel = 2,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const H = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <div className={cx('empty-state', className)}>
      <div className="empty-state-icon" aria-hidden="true">
        {icon ?? <IconInbox />}
      </div>
      <H className="empty-state-title">{title}</H>
      {children ? <div className="empty-state-text">{children}</div> : null}
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
    </div>
  );
}
