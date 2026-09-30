// Notice: an inline message with a tone, an icon shape per tone, and a spoken prefix, so the
// tone never depends on color. `live` makes it a live region: 'polite' for status updates,
// 'assertive' only for errors that block the task. For messages that change after load, keep the
// Notice mounted and change its children (live regions announce changes, not first paint).
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';
import { IconAlert, IconAlertCircle, IconCheckCircle, IconInfo } from './icons.tsx';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const CLASS: Record<NoticeTone, string> = {
  info: 'notice-info',
  success: 'notice-ok',
  warning: 'notice-warn',
  danger: 'notice-danger',
};

const PREFIX: Record<NoticeTone, string> = {
  info: 'Note: ',
  success: 'Done: ',
  warning: 'Warning: ',
  danger: 'Error: ',
};

function ToneIcon({ tone }: { tone: NoticeTone }) {
  const p = { className: 'notice-icon', size: 22 };
  if (tone === 'success') return <IconCheckCircle {...p} />;
  if (tone === 'warning') return <IconAlert {...p} />;
  if (tone === 'danger') return <IconAlertCircle {...p} />;
  return <IconInfo {...p} />;
}

export type NoticeProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  tone?: NoticeTone;
  title?: ReactNode;
  live?: 'polite' | 'assertive';
  icon?: boolean;
  actions?: ReactNode;
};

export function Notice({ tone = 'info', title, live, icon = true, actions, className, children, ...rest }: NoticeProps) {
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  return (
    <div className={cx('notice', CLASS[tone], icon && 'has-icon', className)} role={role} {...rest}>
      {icon ? <ToneIcon tone={tone} /> : null}
      <div className="notice-body">
        {title ? (
          <p className="notice-title">
            <span className="visually-hidden">{PREFIX[tone]}</span>
            {title}
          </p>
        ) : (
          <span className="visually-hidden">{PREFIX[tone]}</span>
        )}
        {children}
        {actions ? <div className="notice-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
