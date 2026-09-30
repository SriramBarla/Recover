// Progress: a labelled native <progress>. Omit `value` for an indeterminate bar.
// Announce milestones (not every percent) through a LiveRegion or Notice.
import { useId, type ReactNode } from 'react';
import { cx } from './cx.ts';

export function Progress({
  label,
  value,
  max = 100,
  valueText,
  className,
}: {
  label: ReactNode;
  value?: number;
  max?: number;
  // Visible value, for example "2 of 3 photos". Defaults to a percentage.
  valueText?: string;
  className?: string;
}) {
  const id = useId();
  const pct = value === undefined ? null : Math.round((Math.min(Math.max(value, 0), max) / max) * 100);
  return (
    <div className={cx('progress', className)}>
      <div className="progress-label">
        <span id={id}>{label}</span>
        {pct !== null ? <span className="progress-value">{valueText ?? `${pct}%`}</span> : null}
      </div>
      <progress className="progress-bar" aria-labelledby={id} max={max} value={value} aria-valuetext={valueText} />
    </div>
  );
}
