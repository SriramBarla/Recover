// Recover icon set: hand-drawn inline SVG on a 24px grid, 1.75px round strokes, currentColor.
// Decorative by default (aria-hidden). Pass `title` only when the icon is the sole label.
// Each icon is its own export so client bundles only carry the icons they import.
import type { ReactNode, SVGProps } from 'react';
import { cx } from './cx.ts';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: number;
  title?: string;
};

export type IconComponent = (props: IconProps) => ReactNode;

function Svg({ size = 20, title, className, strokeWidth = 1.75, children, ...rest }: IconProps & { children: ReactNode }) {
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('icon', className)}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

// ---------- item categories ----------

export function IconBag(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 10a4.5 4.5 0 0 1 4.5-4.5h3A4.5 4.5 0 0 1 18 10v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z" />
      <path d="M9.5 5.5V4.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5v1" />
      <path d="M9 21v-4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V21" />
      <path d="M6 12.5h12" />
    </Svg>
  );
}

export function IconBottle(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9.5" y="2" width="5" height="3" rx="1" />
      <path d="M10 5v1.2c0 .8-.4 1.5-1 2A3 3 0 0 0 8 10.5V20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-9.5a3 3 0 0 0-1-2.3c-.6-.5-1-1.2-1-2V5" />
      <path d="M8 13h8M8 17.5h8" />
    </Svg>
  );
}

export function IconBook(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 19.5V5a2 2 0 0 1 2-2h12v14.5H7a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 7 21.5h12" />
      <path d="M9 7.5h6M9 11h4" />
    </Svg>
  );
}

export function IconClothing(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8.5 3 3 5.8l1.6 4.6 2.4-1V21h10V9.4l2.4 1L21 5.8 15.5 3c-.5 1.6-1.8 2.6-3.5 2.6S9 4.6 8.5 3Z" />
    </Svg>
  );
}

export function IconElectronics(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 15.5V12a8 8 0 0 1 16 0v3.5" />
      <rect x="3" y="14" width="4.5" height="7" rx="1.5" />
      <rect x="16.5" y="14" width="4.5" height="7" rx="1.5" />
    </Svg>
  );
}

export function IconJewelry(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="15.5" r="5.5" />
      <path d="M9.2 6.3 10.6 4h2.8l1.4 2.3L12 9.6Z" />
    </Svg>
  );
}

export function IconSports(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3v18" />
      <path d="M5.6 5.6a9 9 0 0 1 0 12.8M18.4 5.6a9 9 0 0 0 0 12.8" />
    </Svg>
  );
}

export function IconOther(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </Svg>
  );
}

export function IconPhone(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </Svg>
  );
}

export function IconWallet(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
      <path d="M21 11h-4a2 2 0 0 0 0 4h4" />
      <path d="m6 6 9.5-3 1 3" />
    </Svg>
  );
}

export function IconKeys(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="4.5" />
      <circle cx="8" cy="8" r="1.2" />
      <path d="m11.2 11.2 9 9M16 16l2.2-2.2M18.7 18.7l1.8-1.8" />
    </Svg>
  );
}

export function IconId(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8.5" cy="10.8" r="2" />
      <path d="M5.5 16c.5-1.5 1.6-2.3 3-2.3s2.5.8 3 2.3M14 10h4.5M14 13.5h3" />
    </Svg>
  );
}

export function IconMedication(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.97 18.97 18.97 9.97a3.5 3.5 0 0 0-4.94-4.94L5.03 14.03a3.5 3.5 0 0 0 4.94 4.94Z" />
      <path d="m9.53 9.53 4.94 4.94" />
    </Svg>
  );
}

// ---------- actions and objects ----------

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </Svg>
  );
}

export function IconCamera(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2L9 3.5h6L16.5 6h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Svg>
  );
}

export function IconMapPin(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 21.5s-6.5-5.6-6.5-11.2a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11.2-6.5 11.2Z" />
      <circle cx="12" cy="10.3" r="2.3" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function IconCheckCircle(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16 9.5" />
    </Svg>
  );
}

export function IconX(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconAlert(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.3 4.2 2.8 17.4A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3.1L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.2M12 17.1v.1" />
    </Svg>
  );
}

export function IconAlertCircle(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2M12 16.3v.1" />
    </Svg>
  );
}

export function IconInfo(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.7v.1" />
    </Svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Svg>
  );
}

export function IconBuilding(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 21V9.5L12 4l8 5.5V21M2.5 21h19" />
      <path d="M10 21v-5h4v5" />
      <circle cx="12" cy="10.5" r="1.6" />
    </Svg>
  );
}

export function IconUser(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </Svg>
  );
}

export function IconUsers(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14a6.5 6.5 0 0 1 3 6" />
    </Svg>
  );
}

export function IconShield(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 5 5.8v5.4c0 4.5 2.9 8.3 7 9.8 4.1-1.5 7-5.3 7-9.8V5.8Z" />
    </Svg>
  );
}

export function IconShieldCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 5 5.8v5.4c0 4.5 2.9 8.3 7 9.8 4.1-1.5 7-5.3 7-9.8V5.8Z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </Svg>
  );
}

export function IconLock(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </Svg>
  );
}

export function IconEye(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function IconEyeOff(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.5M6.2 7.2C3.9 8.9 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.8 0 3.3-.6 4.6-1.4" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17" />
    </Svg>
  );
}

export function IconGlobe(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3Z" />
    </Svg>
  );
}

export function IconPencil(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5Z" />
      <path d="m13.5 7 3 3" />
    </Svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M9.5 7V4.5h5V7" />
      <path d="m6.5 7 1 13.5h9l1-13.5M10 11v6M14 11v6" />
    </Svg>
  );
}

export function IconGift(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="8" width="17" height="4" rx="1" />
      <path d="M5 12v8.5h14V12M12 8v12.5" />
      <path d="M12 8C10.5 4.5 7 4.5 7 6.5 7 8 9.5 8 12 8Zm0 0c1.5-3.5 5-3.5 5-1.5 0 1.5-2.5 1.5-5 1.5Z" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5" />
    </Svg>
  );
}

export function IconTransfer(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5" />
      <path d="M20 16H6M9.5 12.5 6 16l3.5 3.5" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconChevronLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m14.5 5-7 7 7 7" />
    </Svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m9.5 5 7 7-7 7" />
    </Svg>
  );
}

export function IconChevronDown(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m5 9.5 7 7 7-7" />
    </Svg>
  );
}

export function IconArrowLeft(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  );
}

export function IconArrowRight(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  );
}

export function IconInbox(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 13.5 5.5 5h13l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19Z" />
      <path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" />
    </Svg>
  );
}

export function IconFlag(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 21V4M5 4.5h11l-2 4 2 4H5" />
    </Svg>
  );
}

export function IconImage(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.8" />
      <path d="m21 16-5-5-9 9" />
    </Svg>
  );
}

export function IconUpload(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </Svg>
  );
}

export function IconCrosshair(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </Svg>
  );
}

export function IconCalendar(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </Svg>
  );
}

export function IconList(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Svg>
  );
}

export function IconSliders(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </Svg>
  );
}

export function IconChart(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 20.5h18M6.5 17v-6M11.5 17V6M16.5 17v-4" />
    </Svg>
  );
}

export function IconMap(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20Z" />
      <path d="M8.5 4v13.5M15.5 6.5V20" />
    </Svg>
  );
}

export function IconHome(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1Z" />
    </Svg>
  );
}

export function IconBell(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" />
      <path d="M10 21h4" />
    </Svg>
  );
}

export function IconLogOut(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" />
    </Svg>
  );
}

export function IconTag(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 12.1V4.5a1 1 0 0 1 1-1h7.6a1 1 0 0 1 .7.3l8.2 8.2a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0L3.8 12.8a1 1 0 0 1-.3-.7Z" />
      <circle cx="8" cy="8" r="1.5" />
    </Svg>
  );
}
