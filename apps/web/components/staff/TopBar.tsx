import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { IconLogOut } from '@/components/ui/icons.tsx';
import { SchoolSwitcher, type SchoolOption } from '@/components/ui/school-switcher.tsx';
import { TopNav, type NavItem } from '@/components/ui/top-nav.tsx';
import { signOutAction } from './actions.ts';

export type TopBarContext = {
  label?: string;
  name: string;
  code?: string | null;
  // Other schools this person can switch to; with allHref the context becomes a menu.
  schools?: SchoolOption[];
  allHref?: string;
};

type Props = {
  brandHref: string;
  // What the person is acting on (a school, or the district): always the most visible thing here.
  context?: TopBarContext | null;
  items?: NavItem[];
  navLabel?: string;
  userLabel?: string | null;
  links?: ReactNode;
};

// Staff and district header: brand, the school or area being acted on, section nav (aria-current),
// the signed-in user, and sign out. Dense (.compact) like the rest of the staff app.
export function TopBar({ brandHref, context, items, navLabel, userLabel, links }: Props) {
  return (
    <TopNav
      className="compact"
      homeHref={brandHref}
      context={
        context ? (
          <SchoolSwitcher
            current={{ code: context.code, name: context.name }}
            label={context.label}
            schools={context.schools}
            allHref={context.allHref}
          />
        ) : null
      }
      items={items}
      navLabel={navLabel}
      end={
        <>
          {links}
          {userLabel ? <span className="topbar-user">{userLabel}</span> : null}
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm" icon={<IconLogOut />}>
              Sign out
            </Button>
          </form>
        </>
      }
    />
  );
}
