// Stat: a KPI tile for staff and district dashboards (uses the .kpis / .kpi classes).
// A tone adds a side bar; say what the tone means in `hint` so it is not color alone.
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
  className?: string;
}) {
  return (
    <div className={cx('kpi', tone && `kpi-${tone}`, className)}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {hint ? <div className="kpi-hint">{hint}</div> : null}
    </div>
  );
}

export function StatGrid({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('kpis', className)} role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  );
}
