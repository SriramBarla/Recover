// LiveRegion: a region that is always mounted, whose text changes are announced.
// Render it once, then update `message` (for upload progress, pin placement, saved states).
import { cx } from './cx.ts';

export function LiveRegion({
  message,
  politeness = 'polite',
  visible = false,
  className,
  id,
}: {
  message: string;
  politeness?: 'polite' | 'assertive';
  visible?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <div id={id} aria-live={politeness} aria-atomic="true" className={cx(!visible && 'visually-hidden', className)}>
      {message}
    </div>
  );
}
