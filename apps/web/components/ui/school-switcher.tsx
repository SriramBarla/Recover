// SchoolSwitcher: always shows which school a staff member is acting on (name and code). With
// more than one school it becomes a native <details> disclosure listing the others as links,
// so it needs no JavaScript. District pages pass label="District".
import Link from 'next/link';
import { cx } from './cx.ts';
import { IconBuilding, IconCheck, IconChevronDown } from './icons.tsx';

export type SchoolOption = { code: string; name: string; href: string };

export type SchoolSwitcherProps = {
  current: { code?: string | null; name: string };
  schools?: readonly SchoolOption[];
  label?: string;
  // Link to the full picker (for example /staff), shown at the end of the menu.
  allHref?: string;
  className?: string;
};

function Current({ current, label, withChevron }: { current: SchoolSwitcherProps['current']; label: string; withChevron: boolean }) {
  return (
    <>
      <span className="school-switcher-icon" aria-hidden="true">
        <IconBuilding size={18} />
      </span>
      <span className="school-switcher-text">
        <span className="school-switcher-label">{label}</span>
        <span className="school-switcher-name">{current.name}</span>
      </span>
      {current.code ? <span className="school-switcher-code">{current.code}</span> : null}
      {withChevron ? <IconChevronDown className="school-switcher-chevron" size={18} /> : null}
    </>
  );
}

export function SchoolSwitcher({ current, schools = [], label = 'Acting for', allHref, className }: SchoolSwitcherProps) {
  if (schools.length <= 1 && !allHref) {
    return (
      <div className={cx('school-switcher', className)}>
        <div className="school-switcher-current">
          <Current current={current} label={label} withChevron={false} />
        </div>
      </div>
    );
  }
  return (
    <details className={cx('school-switcher', className)}>
      <summary className="school-switcher-current">
        <Current current={current} label={label} withChevron />
        <span className="visually-hidden">, switch school</span>
      </summary>
      <ul className="school-switcher-menu">
        {schools.map((s) => {
          const isCurrent = s.code === current.code;
          return (
            <li key={s.code}>
              <Link href={s.href} aria-current={isCurrent ? 'true' : undefined}>
                <span>
                  {s.name} <span className="muted mono small">{s.code}</span>
                </span>
                {isCurrent ? <IconCheck size={18} /> : null}
              </Link>
            </li>
          );
        })}
        {allHref ? (
          <li>
            <Link href={allHref}>All my schools</Link>
          </li>
        ) : null}
      </ul>
    </details>
  );
}
