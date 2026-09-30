// Skeletons: placeholder shapes while content loads. Shapes are hidden from assistive technology;
// wrap a group in <Loading label="..."> so one polite "Loading items" is announced instead.
// The shimmer stops under prefers-reduced-motion.
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx.ts';

export function Skeleton({
  width,
  height,
  radius,
  circle = false,
  text = false,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  circle?: boolean;
  text?: boolean;
  className?: string;
}) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  if (radius !== undefined) style.borderRadius = radius;
  return <span aria-hidden="true" className={cx('skeleton', circle && 'skeleton-circle', text && 'skeleton-text', className)} style={style} />;
}

export function SkeletonText({ lines = 2, lastWidth = '60%' }: { lines?: number; lastWidth?: string }) {
  return (
    <span aria-hidden="true" style={{ display: 'block' }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} text width={i === lines - 1 ? lastWidth : '100%'} />
      ))}
    </span>
  );
}

// Matches ItemCard's footprint so swapping in real cards causes no layout shift.
export function SkeletonItemCard() {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      <Skeleton className="skeleton-thumb" />
      <div className="skeleton-body">
        <SkeletonText lines={2} />
        <Skeleton text width="45%" />
      </div>
    </div>
  );
}

export function Loading({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className} aria-busy="true">
      <span className="visually-hidden" role="status">
        {label}
      </span>
      {children}
    </div>
  );
}
