// The Recover mark: a lost-and-found tag with a warm eyelet and a check (found, returned).
// Colors come from --logo-* tokens so the mark stays legible in both themes.
import { cx } from './cx.ts';

export function LogoMark({ size = 30, className, title }: { size?: number; className?: string; title?: string }) {
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cx('logo-mark', className)}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
    >
      {labelled ? <title>{title}</title> : null}
      <rect className="lm-bg" width="32" height="32" rx="9" />
      <g transform="translate(-2 -2) rotate(45 16 16)">
        <path className="lm-tag" d="M12 10H24a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H12L6.5 16Z" strokeWidth="1.5" strokeLinejoin="round" />
        <circle className="lm-hole" cx="11.4" cy="16" r="1.9" />
      </g>
      <path
        className="lm-check"
        d="M12.7 16.5 15 18.8l4.6-4.8"
        fill="none"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Mark plus wordmark. `context` adds a quieter second label, such as the school name.
export function Logo({ size = 30, context, className }: { size?: number; context?: string | null; className?: string }) {
  return (
    <span className={cx('brand', className)}>
      <LogoMark size={size} />
      <span className="brand-name">Recover</span>
      {context ? <span className="brand-context">{context}</span> : null}
    </span>
  );
}
