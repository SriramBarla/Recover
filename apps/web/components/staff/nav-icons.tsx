// Icons for the staff and district sections (presentation only; the section list is lib/ops.ts).
import type { ReactNode } from 'react';
import {
  IconBuilding,
  IconChart,
  IconHome,
  IconInbox,
  IconMap,
  IconMapPin,
  IconPlus,
  IconSearch,
  IconSliders,
  IconUsers,
} from '@/components/ui/icons.tsx';

const SECTION_ICONS: Record<string, ReactNode> = {
  queue: <IconInbox />,
  custody: <IconBuilding />,
  post: <IconPlus />,
  reports: <IconSearch />,
  stats: <IconChart />,
  roster: <IconUsers />,
  locations: <IconMapPin />,
  map: <IconMap />,
  config: <IconSliders />,
  overview: <IconHome />,
  schools: <IconBuilding />,
  maps: <IconMap />,
  settings: <IconSliders />,
};

export function sectionIcon(seg: string): ReactNode {
  return SECTION_ICONS[seg] ?? null;
}
