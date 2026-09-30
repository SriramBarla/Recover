// Table: a data table in a scroll container. The caption names the table (and the scroll
// region, which is keyboard-focusable so a wide table can be scrolled without a mouse at 320px).
// Mark numeric cells with className="num" and action cells with className="actions".
import { useId, type ReactNode, type TableHTMLAttributes } from 'react';
import { cx } from './cx.ts';

export type TableProps = TableHTMLAttributes<HTMLTableElement> & {
  caption: ReactNode;
  hideCaption?: boolean;
  dense?: boolean;
  wrapClassName?: string;
};

export function Table({ caption, hideCaption = false, dense = false, wrapClassName, className, children, ...rest }: TableProps) {
  const id = useId();
  return (
    <div className={cx('table-wrap', wrapClassName)} role="region" aria-labelledby={id} tabIndex={0}>
      <table className={cx('table', dense && 'table-dense', className)} {...rest}>
        <caption id={id} className={hideCaption ? 'visually-hidden' : undefined}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}
