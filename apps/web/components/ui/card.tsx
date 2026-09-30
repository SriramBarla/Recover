// Card: the default surface for grouped content. Optional header (title, description, actions)
// and footer. Use `as="li"` inside lists and `as="section"` with a title for page regions.
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';

export type CardProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
  title?: ReactNode;
  titleLevel?: 2 | 3 | 4;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  muted?: boolean;
};

export function Card({
  as: Tag = 'div',
  title,
  titleLevel = 2,
  description,
  actions,
  footer,
  padding = 'md',
  muted = false,
  className,
  children,
  ...rest
}: CardProps) {
  const H = `h${titleLevel}` as 'h2' | 'h3' | 'h4';
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <Tag
      className={cx(
        'card',
        padding === 'none' && 'card-pad-none',
        padding === 'sm' && 'card-pad-sm',
        padding === 'lg' && 'card-pad-lg',
        muted && 'card-muted',
        className,
      )}
      {...rest}
    >
      {hasHeader ? (
        <div className="card-header">
          <div>
            {title !== undefined ? <H className="card-title">{title}</H> : null}
            {description ? <p className="card-desc">{description}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
      {footer ? <div className="card-footer">{footer}</div> : null}
    </Tag>
  );
}
