// KeyValue: a description list for item details, settings summaries, and review facts.
// Two columns on wide screens, stacked under 30rem (or always, with stacked).
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export type KeyValueItem = { label: ReactNode; value: ReactNode; key?: string };

export function KeyValue({ items, stacked = false, className }: { items: readonly KeyValueItem[]; stacked?: boolean; className?: string }) {
  return (
    <dl className={cx('kv', stacked && 'kv-stacked', className)}>
      {items.map((it, i) => (
        <KeyValueRow key={it.key ?? i} label={it.label} value={it.value} />
      ))}
    </dl>
  );
}

function KeyValueRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
