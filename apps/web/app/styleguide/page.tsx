// /styleguide: every shared component in every state, in a light and a dark panel side by side.
// Development only: production builds return 404.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge, CountBadge } from '@/components/ui/badge.tsx';
import { Button, LinkButton } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { CATEGORY_HINT, CategoryIcon, categoryLabel } from '@/components/ui/category.tsx';
import { Chip, ChipGroup, ChipLink } from '@/components/ui/chip.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { Fieldset, PrivateNote, TextInput } from '@/components/ui/field.tsx';
import * as I from '@/components/ui/icons.tsx';
import { ItemCard } from '@/components/ui/item-card.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { KeyValue } from '@/components/ui/key-value.tsx';
import { Logo, LogoMark } from '@/components/ui/logo.tsx';
import { MapPicker } from '@/components/ui/map-picker.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { PageHeader } from '@/components/ui/page-header.tsx';
import { Progress } from '@/components/ui/progress.tsx';
import { SchoolSwitcher } from '@/components/ui/school-switcher.tsx';
import { Select } from '@/components/ui/select.tsx';
import { Loading, SkeletonItemCard, SkeletonText, Skeleton } from '@/components/ui/skeleton.tsx';
import { Stat, StatGrid } from '@/components/ui/stat.tsx';
import { FlagChip, StatusBadge, type StatusKind } from '@/components/ui/status-badge.tsx';
import { Stepper } from '@/components/ui/stepper.tsx';
import { SubNav } from '@/components/ui/sub-nav.tsx';
import { Table } from '@/components/ui/table.tsx';
import { TextArea } from '@/components/ui/text-area.tsx';
import { TileLink, TileRadio } from '@/components/ui/tile.tsx';
import { TopNav } from '@/components/ui/top-nav.tsx';
import { CAMPUS_MAP, DEMO_ZONES, MAP_HEIGHT, MAP_WIDTH, PHOTO_BACKPACK, PHOTO_BOTTLE, PHOTO_BOTTLE_2, PHOTO_HOODIE } from './assets.ts';
import {
  BulkConfirmDemo,
  ChipToggleDemo,
  ConfirmDemo,
  LoadingButtonDemo,
  MapPickerDemo,
  PhotoCaptureDemo,
  PrimaryConfirmDemo,
  TextAreaDemo,
  TileToggleDemo,
  ZoneEditorDemo,
} from './demos.tsx';
import './styleguide.css';

export const metadata: Metadata = { title: 'Styleguide · Recover' };

type P = 'l' | 'd';

function Pair({ render }: { render: (p: P) => ReactNode }) {
  return (
    <div className="sg-pair">
      <div className="sg-panel" data-theme="light">
        <p className="sg-panel-label">Light</p>
        {render('l')}
      </div>
      <div className="sg-panel" data-theme="dark">
        <p className="sg-panel-label">Dark</p>
        {render('d')}
      </div>
    </div>
  );
}

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="sg-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {note ? <p className="sg-note">{note}</p> : null}
      {children}
    </section>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <h3 className="sg-sub">{children}</h3>;
}

const SECTIONS: [string, string][] = [
  ['brand', 'Brand'],
  ['color', 'Color'],
  ['type', 'Type'],
  ['scale', 'Space, radii, shadow'],
  ['icons', 'Icons'],
  ['buttons', 'Buttons'],
  ['badges', 'Badges and chips'],
  ['status', 'Status badges'],
  ['notices', 'Notices'],
  ['forms', 'Forms'],
  ['tiles', 'Tiles'],
  ['stepper', 'Stepper'],
  ['nav', 'Navigation'],
  ['items', 'Item cards'],
  ['map', 'Map picker'],
  ['photos', 'Photo capture'],
  ['confirm', 'Confirm action'],
  ['data', 'Tables and lists'],
  ['feedback', 'Empty, loading, progress'],
];

const SWATCHES = [
  'bg', 'surface', 'surface-2', 'surface-3', 'track', 'text', 'muted', 'border', 'border-strong',
  'brand', 'brand-hover', 'brand-soft', 'brand-strong', 'accent', 'accent-soft', 'accent-strong',
  'ok', 'ok-soft', 'warn', 'warn-soft', 'danger', 'danger-soft', 'focus', 'logo-accent',
];

const ICONS: [string, I.IconComponent][] = [
  ['bag', I.IconBag], ['bottle', I.IconBottle], ['book', I.IconBook], ['clothing', I.IconClothing],
  ['electronics', I.IconElectronics], ['jewelry', I.IconJewelry], ['sports', I.IconSports], ['other', I.IconOther],
  ['phone', I.IconPhone], ['wallet', I.IconWallet], ['keys', I.IconKeys], ['id', I.IconId],
  ['medication', I.IconMedication], ['search', I.IconSearch], ['camera', I.IconCamera], ['map-pin', I.IconMapPin],
  ['check', I.IconCheck], ['check-circle', I.IconCheckCircle], ['x', I.IconX], ['alert', I.IconAlert],
  ['alert-circle', I.IconAlertCircle], ['info', I.IconInfo], ['clock', I.IconClock], ['building', I.IconBuilding],
  ['user', I.IconUser], ['users', I.IconUsers], ['shield', I.IconShield], ['shield-check', I.IconShieldCheck],
  ['lock', I.IconLock], ['eye', I.IconEye], ['eye-off', I.IconEyeOff], ['globe', I.IconGlobe],
  ['pencil', I.IconPencil], ['trash', I.IconTrash], ['gift', I.IconGift], ['refresh', I.IconRefresh],
  ['transfer', I.IconTransfer], ['plus', I.IconPlus], ['chevron-left', I.IconChevronLeft], ['chevron-right', I.IconChevronRight],
  ['chevron-down', I.IconChevronDown], ['arrow-left', I.IconArrowLeft], ['arrow-right', I.IconArrowRight], ['inbox', I.IconInbox],
  ['flag', I.IconFlag], ['image', I.IconImage], ['upload', I.IconUpload], ['crosshair', I.IconCrosshair],
  ['calendar', I.IconCalendar], ['list', I.IconList], ['sliders', I.IconSliders], ['chart', I.IconChart],
  ['map', I.IconMap], ['home', I.IconHome], ['bell', I.IconBell], ['log-out', I.IconLogOut], ['tag', I.IconTag],
];

const STATUS: [StatusKind, string[]][] = [
  ['review', ['draft', 'pending', 'approved', 'rejected']],
  ['publication', ['hidden', 'generating', 'published', 'withdrawn']],
  ['custody', ['with_finder', 'at_location', 'claimed', 'expired_donated', 'expired_disposed', 'expired_never_arrived']],
  ['report', ['open', 'closed_found', 'closed_by_user', 'closed_by_staff', 'expired']],
  ['map', ['draft', 'pending_district', 'approved', 'rejected', 'retired']],
  ['member', ['invited', 'active', 'deactivated']],
  ['screening', ['unscreened', 'clean', 'flagged', 'error']],
];

const STUDENT_CATS = ['bag', 'bottle', 'clothing', 'book', 'electronics_low', 'jewelry', 'sports', 'other'];
const OFFICE_CATS = ['phone', 'wallet', 'keys', 'id_card', 'medication'];

const STAFF_NAV = [
  { href: '/staff/FCHS/queue', label: 'Review', icon: <I.IconInbox />, count: 7, countLabel: 'waiting for review' },
  { href: '/staff/FCHS/custody', label: 'Custody', icon: <I.IconBuilding /> },
  { href: '/staff/FCHS/post', label: 'Post item', icon: <I.IconPlus /> },
  { href: '/staff/FCHS/reports', label: 'Lost reports', icon: <I.IconSearch /> },
  { href: '/staff/FCHS/stats', label: 'Stats', icon: <I.IconChart /> },
];

export default function StyleguidePage() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main id="main" className="sg-container">
      <header className="sg-hero">
        <Logo size={40} context="Design system" />
        <h1>Recover design system</h1>
        <p className="sg-lede">
          Calm, trustworthy, and fast at dismissal. Warm paper neutrals, a deep teal brand, and one warm accent. Every specimen renders
          in a forced light panel and a forced dark panel. Usage notes live in docs/DESIGN.md.
        </p>
        <nav aria-label="Styleguide sections">
          <ul className="sg-toc">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a className="chip chip-sm" href={`#${id}`}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <Section id="brand" title="Brand" note="The mark is a lost-and-found tag with a warm eyelet and a check: found, and on its way back.">
        <Pair
          render={() => (
            <div className="sg-stack">
              <div className="sg-row">
                <LogoMark size={16} />
                <LogoMark size={24} />
                <LogoMark size={32} />
                <LogoMark size={48} />
                <LogoMark size={72} />
              </div>
              <div className="sg-row">
                <Logo />
                <Logo context="Fairview High" />
              </div>
            </div>
          )}
        />
      </Section>

      <Section id="color" title="Color" note="Tokens, not hex values, in every component. Text pairs meet 4.5:1; control borders, focus, and the map pin meet 3:1.">
        <Pair
          render={() => (
            <div className="sg-swatches">
              {SWATCHES.map((t) => (
                <div className="sg-swatch" key={t}>
                  <div className="sg-swatch-chip" style={{ background: `var(--${t})` }} />
                  <div className="sg-swatch-name">--{t}</div>
                </div>
              ))}
            </div>
          )}
        />
      </Section>

      <Section id="type" title="Type" note="System fonts only. 16px body at 1.5; headings tight; tabular numbers in tables and stats.">
        <Pair
          render={() => (
            <div className="sg-type">
              <h1>Found something? Post it in a minute.</h1>
              <h2>Your lost reports</h2>
              <h3>Expected arrivals today</h3>
              <h4>Drop-off hours</h4>
              <p>
                Body text for plain instructions. Bring it to the Main Office by the end of the next school day. It appears once staff
                check it in. <a href="#type">A link looks like this.</a>
              </p>
              <p className="small muted">Small muted text for hints and metadata.</p>
              <p className="mono">FCHS-M-000214</p>
              <p>
                Press <Kbd>A</Kbd> to approve or <Kbd>R</Kbd> to reject.
              </p>
            </div>
          )}
        />
      </Section>

      <Section id="scale" title="Space, radii, shadow" note="A 4px spacing scale, five radii, three elevations, and motion tokens that drop to 0 under reduced motion.">
        <Pair
          render={() => (
            <div className="sg-two">
              <div className="sg-scale">
                {[1, 2, 3, 4, 5, 6, 8, 10, 12, 16].map((n) => (
                  <div className="sg-scale-row" key={n}>
                    <span>--space-{n}</span>
                    <span className="sg-bar" style={{ width: `var(--space-${n})` }} />
                  </div>
                ))}
              </div>
              <div className="sg-stack">
                <div className="sg-boxes">
                  {['xs', 'sm', 'md', '', 'lg', 'xl'].map((r) => (
                    <div className="sg-box" key={r || 'base'} style={{ borderRadius: `var(--radius${r ? `-${r}` : ''})` }}>
                      --radius{r ? `-${r}` : ''}
                    </div>
                  ))}
                </div>
                <div className="sg-boxes">
                  {['shadow-sm', 'shadow', 'shadow-lg'].map((s) => (
                    <div className="sg-box" key={s} style={{ boxShadow: `var(--${s})`, borderRadius: 'var(--radius)' }}>
                      --{s}
                    </div>
                  ))}
                </div>
                <p className="small muted mono">--dur-fast 120ms, --dur 180ms, --dur-slow 280ms, --ease</p>
              </div>
            </div>
          )}
        />
      </Section>

      <Section id="icons" title="Icons" note="Hand-drawn 24px outline icons, currentColor, decorative unless given a title.">
        <Pair
          render={() => (
            <div className="sg-icons">
              {ICONS.map(([name, Icon]) => (
                <div className="sg-icon" key={name}>
                  <Icon size={24} />
                  {name}
                </div>
              ))}
            </div>
          )}
        />
      </Section>

      <Section id="buttons" title="Buttons" note="Primary for the one main action per view; danger only for destructive steps. 44px tall by default, 32px small (staff tables).">
        <Pair
          render={() => (
            <div className="sg-stack">
              <Sub>Variants</Sub>
              <div className="sg-row">
                <Button variant="primary">Found something</Button>
                <Button variant="secondary">I lost something</Button>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Reject</Button>
                <Button variant="danger-outline">Dispose</Button>
              </div>
              <Sub>Sizes and icons</Sub>
              <div className="sg-row">
                <Button variant="primary" size="lg" icon={<I.IconCamera />}>
                  Take photo
                </Button>
                <Button icon={<I.IconMapPin />}>Pick on map</Button>
                <Button size="sm" icon={<I.IconCheck />}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" iconEnd={<I.IconChevronRight />}>
                  Next
                </Button>
                <Button variant="primary" iconOnly aria-label="Search" icon={<I.IconSearch />} />
                <Button iconOnly size="sm" aria-label="Remove" icon={<I.IconX />} />
              </div>
              <Sub>States</Sub>
              <div className="sg-row">
                <Button variant="primary" disabled>
                  Disabled
                </Button>
                <Button variant="primary" loading loadingText="Uploading...">
                  Submit
                </Button>
                <Button loading>Saving</Button>
                <LoadingButtonDemo />
                <Button className="sg-focus-demo">Focus ring</Button>
              </div>
              <Sub>Links that look like buttons, block width</Sub>
              <div className="sg-stack sg-phone">
                <LinkButton href="#buttons" variant="primary" size="lg" block icon={<I.IconCamera />}>
                  Found something
                </LinkButton>
                <LinkButton href="#buttons" size="lg" block icon={<I.IconSearch />}>
                  I lost something
                </LinkButton>
              </div>
            </div>
          )}
        />
      </Section>

      <Section id="badges" title="Badges and chips">
        <Pair
          render={() => (
            <div className="sg-stack">
              <Sub>Badge tones</Sub>
              <div className="sg-row">
                <Badge>Neutral</Badge>
                <Badge tone="brand" icon={<I.IconGlobe />}>
                  Brand
                </Badge>
                <Badge tone="ok" icon={<I.IconCheck />}>
                  OK
                </Badge>
                <Badge tone="warn" icon={<I.IconClock />}>
                  Warning
                </Badge>
                <Badge tone="danger" icon={<I.IconX />}>
                  Danger
                </Badge>
                <Badge tone="accent" icon={<I.IconBell />}>
                  New match
                </Badge>
                <Badge tone="brand" size="lg">
                  Large
                </Badge>
                <span className="sg-row">
                  Reports <CountBadge count={3} label="new matches" />
                </span>
              </div>
              <Sub>Chips: static, filter links, toggles, flags</Sub>
              <div className="chips">
                <Chip icon={<I.IconMapPin />}>Gym</Chip>
                <Chip size="sm">Sep 29</Chip>
              </div>
              <ChipGroup label="Filter by pickup location">
                <ChipLink href="#badges" selected>
                  All locations
                </ChipLink>
                <ChipLink href="#badges" icon={<I.IconBuilding size={16} />}>
                  Main Office
                </ChipLink>
                <ChipLink href="#badges" icon={<I.IconBuilding size={16} />}>
                  West desk
                </ChipLink>
              </ChipGroup>
              <ChipToggleDemo />
              <div className="chips">
                {['nsfw', 'has_face', 'has_text', 'contact_info', 'duplicate', 'repeat_device', 'screening_error'].map((f) => (
                  <FlagChip key={f} flag={f} />
                ))}
              </div>
            </div>
          )}
        />
      </Section>

      <Section id="status" title="Status badges" note="One vocabulary for every state machine. Each state has an icon and words, never color alone.">
        <Pair
          render={() => (
            <div className="sg-stack">
              {STATUS.map(([kind, states]) => (
                <div key={kind}>
                  <Sub>{kind}</Sub>
                  <div className="sg-row">
                    {states.map((s) => (
                      <StatusBadge key={s} kind={kind} status={s} />
                    ))}
                  </div>
                </div>
              ))}
              <div>
                <Sub>Label override and context</Sub>
                <div className="sg-row">
                  <StatusBadge kind="custody" status="at_location" label="At West Campus" size="lg" context />
                  <StatusBadge kind="custody" status="with_finder" label="Being brought to Main Office" />
                </div>
              </div>
            </div>
          )}
        />
      </Section>

      <Section id="notices" title="Notices" note="Icon shape, left bar, and a spoken prefix per tone. Use live='polite' for status that changes after load.">
        <Pair
          render={() => (
            <div className="sg-stack">
              <Notice title="Only staff see this">The exact pin and your note help staff find it. The public listing shows only the area name.</Notice>
              <Notice tone="success" title="Posted">
                Bring it to the Main Office by the end of the next school day. It appears once staff check it in.
              </Notice>
              <Notice tone="warning" title="Take it to the office">
                Phones, wallets, keys, IDs, and medication go straight to the Main Office. No photo needed.
              </Notice>
              <Notice
                tone="danger"
                title="Upload failed"
                actions={
                  <>
                    <Button size="sm" variant="primary">
                      Try again
                    </Button>
                    <Button size="sm" variant="ghost">
                      Take it to the office instead
                    </Button>
                  </>
                }
              >
                Your photos did not upload. Check your connection.
              </Notice>
              <Notice icon={false}>A plain notice without an icon still reads as a note.</Notice>
              <div className="notice notice-warn">Legacy markup: the .notice classes keep working without the component.</div>
            </div>
          )}
        />
      </Section>

      <Section id="forms" title="Forms" note="Label, hint, error, then the control. Errors name the fix. Private fields say who can see them.">
        <Pair
          render={(p) => (
            <div className="sg-two">
              <div className="sg-stack">
                <TextInput id={`${p}-note`} label="Location note" hint="For example C214 or 2nd floor hallway." privateNote maxLength={80} optional />
                <TextInput id={`${p}-email`} label="District email" type="email" defaultValue="jlee@fairview" error="Enter a full district email, like jlee@fairviewschools.org." />
                <TextInput id={`${p}-code`} label="School code" defaultValue="FCHS" disabled />
                <Select
                  id={`${p}-loc`}
                  label="Drop-off location"
                  hint="Where you will take it."
                  placeholder="Choose a location"
                  defaultValue="main"
                  options={[
                    { value: 'main', label: 'Main Office (7:30 to 3:30)' },
                    { value: 'west', label: 'West desk (8:00 to 3:00)' },
                  ]}
                />
                <Select id={`${p}-reason`} label="Reject reason" placeholder="Choose a reason" error="Choose why you are rejecting it." options={[{ value: 'spam', label: 'Spam' }]} />
              </div>
              <div className="sg-stack">
                <TextAreaDemo id={`${p}-desc`} />
                <TextArea id={`${p}-lost`} label="What did you lose?" hint="Up to 200 characters." maxLength={200} rows={3} placeholder="navy metal water bottle" />
                <Fieldset id={`${p}-when`} legend="When did you lose it?" hint="Your best guess is fine.">
                  <label className="choice">
                    <input type="radio" name={`${p}-when`} defaultChecked />
                    <span>Today</span>
                  </label>
                  <label className="choice">
                    <input type="radio" name={`${p}-when`} />
                    <span>Earlier this week</span>
                  </label>
                </Fieldset>
                <p className="sg-row">
                  <PrivateNote /> <span className="small muted">stand-alone private marker</span>
                </p>
              </div>
            </div>
          )}
        />
      </Section>

      <Section id="tiles" title="Tiles" note="The found flow's category step: icons, plain words, examples, 100px targets. Office-only categories use the accent.">
        <Pair
          render={(p) => (
            <div className="sg-stack">
              <Sub>TileLink (navigates)</Sub>
              <ul className="tile-grid">
                {STUDENT_CATS.map((c) => (
                  <li key={c}>
                    <TileLink href="#tiles" icon={<CategoryIcon category={c} />} label={categoryLabel(c)} description={CATEGORY_HINT[c as keyof typeof CATEGORY_HINT]} />
                  </li>
                ))}
                {OFFICE_CATS.map((c) => (
                  <li key={c}>
                    <TileLink href="#tiles" accent icon={<CategoryIcon category={c} />} label={categoryLabel(c)} description={CATEGORY_HINT[c as keyof typeof CATEGORY_HINT]} />
                  </li>
                ))}
              </ul>
              <Sub>TileRadio (form value) and TileButton (toggle)</Sub>
              <Fieldset id={`${p}-cat`} legend="What kind of item?" bodyClassName="tile-grid">
                {['bag', 'bottle', 'clothing'].map((c, i) => (
                  <TileRadio key={c} name={`${p}-cat`} value={c} defaultChecked={i === 1} icon={<CategoryIcon category={c} />} label={categoryLabel(c)} />
                ))}
              </Fieldset>
              <TileToggleDemo />
            </div>
          )}
        />
      </Section>

      <Section id="stepper" title="Stepper" note="The text is what screen readers hear; the bar is hidden from them. The current step is half-filled.">
        <Pair
          render={() => (
            <div className="sg-stack sg-phone">
              <Stepper steps={['Category', 'Photos', 'Where', 'Describe', 'Done']} current={1} />
              <Stepper steps={['Category', 'Photos', 'Where', 'Describe', 'Done']} current={3} />
              <Stepper steps={['Category', 'Photos', 'Where', 'Describe', 'Done']} current={5} />
              <ol className="steps">
                <li data-done="true" />
                <li data-done="true" />
                <li />
              </ol>
            </div>
          )}
        />
      </Section>

      <Section id="nav" title="Navigation" note="TopNav with the school always in view for staff; PageHeader for the page's single h1; SubNav for views inside a page.">
        <Pair
          render={() => (
            <div className="sg-stack">
              <Sub>Student</Sub>
              <TopNav
                homeHref="#nav"
                brandContext="Fairview High"
                currentPath="/s/FCHS"
                items={[
                  { href: '/s/FCHS', label: 'Found items', icon: <I.IconHome />, match: 'exact' },
                  { href: '/s/FCHS/lost/mine', label: 'My reports', icon: <I.IconSearch />, count: 2, countLabel: 'new matches' },
                ]}
              />
              <Sub>Staff</Sub>
              <TopNav
                className="compact"
                homeHref="#nav"
                context={
                  <SchoolSwitcher
                    current={{ code: 'FCHS', name: 'Fairview High' }}
                    schools={[
                      { code: 'FCHS', name: 'Fairview High', href: '#nav' },
                      { code: 'LMS', name: 'Lincoln Middle', href: '#nav' },
                    ]}
                    allHref="#nav"
                  />
                }
                currentPath="/staff/FCHS/queue"
                items={STAFF_NAV}
                end={
                  <Button size="sm" variant="ghost" icon={<I.IconLogOut />}>
                    Sign out
                  </Button>
                }
              />
              <Sub>School context</Sub>
              <div className="sg-row">
                <SchoolSwitcher current={{ code: 'LMS', name: 'Lincoln Middle' }} />
                <SchoolSwitcher current={{ name: 'Fairview School District' }} label="District" />
              </div>
              <Sub>Page header and sub navigation</Sub>
              <PageHeader
                back={{ href: '#nav', label: 'Back to custody' }}
                eyebrow="Fairview High · FCHS"
                title="Custody"
                description="Items on their way, in the office, and due for donation."
                actions={
                  <>
                    <Button icon={<I.IconTransfer />}>Transfer</Button>
                    <Button variant="primary" icon={<I.IconCheck />}>
                      Receive
                    </Button>
                  </>
                }
              />
              <SubNav
                label="Custody views"
                current="#expected"
                items={[
                  { href: '#expected', label: 'Expected', count: 4, countLabel: 'items expected' },
                  { href: '#held', label: 'In custody', count: 31, countLabel: 'items held' },
                  { href: '#due', label: 'Disposition due', count: 2, countLabel: 'items due' },
                ]}
              />
            </div>
          )}
        />
      </Section>

      <Section id="items" title="Item cards" note="Fixed 1:1 thumbs with explicit dimensions (no layout shift). Public cards show the zone name, never the exact pin.">
        <Pair
          render={() => (
            <div className="sg-stack">
              <ul className="item-grid">
                <li>
                  <ItemCard
                    href="#items"
                    publicId="FCHS-M-000214"
                    category="bottle"
                    description="Navy metal water bottle with stickers"
                    photo={{ url: PHOTO_BOTTLE, width: 400, height: 400 }}
                    zoneName="Gym"
                    custody="at_location"
                    locationName="Main Office"
                    foundLabel="Found Sep 29"
                    priority
                  />
                </li>
                <li>
                  <ItemCard
                    href="#items"
                    publicId="FCHS-M-000215"
                    category="bag"
                    description="Red backpack, small tear on the front pocket"
                    photo={{ url: PHOTO_BACKPACK }}
                    zoneName="Cafeteria"
                    custody="with_finder"
                    locationName="Main Office"
                    foundLabel="Found today"
                  />
                </li>
                <li>
                  <ItemCard href="#items" publicId="FCHS-W-000031" category="book" description="Blue math binder" custody="at_location" locationName="West desk" />
                </li>
                <li>
                  <ItemCard
                    href="#items"
                    publicId="FCHS-M-000219"
                    category="clothing"
                    description="Green hoodie, size M, with a school logo on the back and paint on the left sleeve near the cuff"
                    photo={{ url: PHOTO_HOODIE }}
                    zoneName="Field"
                    custody="at_location"
                    locationName="Main Office"
                  />
                </li>
              </ul>
              <Sub>Row variant (lost report matches, staff lists)</Sub>
              <ul className="item-list">
                <li>
                  <ItemCard
                    variant="row"
                    href="#items"
                    publicId="FCHS-M-000220"
                    category="bottle"
                    description="Purple water bottle"
                    photo={{ url: PHOTO_BOTTLE_2 }}
                    custody="at_location"
                    locationName="Main Office"
                    status={<Badge tone="accent" icon={<I.IconBell />}>New match</Badge>}
                  />
                </li>
                <li>
                  <ItemCard
                    variant="row"
                    publicId="FCHS-M-000198"
                    category="electronics_low"
                    description="White earbuds case"
                    custody="with_finder"
                    locationName="Main Office"
                    status={
                      <>
                        <StatusBadge kind="review" status="pending" />
                        <StatusBadge kind="publication" status="hidden" />
                      </>
                    }
                  />
                </li>
              </ul>
            </div>
          )}
        />
      </Section>

      <Section id="map" title="Map picker" note="An <img> with a normalized pin. Click or tap to place; keyboard crosshair (arrows, Shift for 5x, Enter); zone list fallback; spoken position.">
        <Pair
          render={() => (
            <div className="sg-stack">
              <Sub>Student: where did you find it?</Sub>
              <MapPickerDemo />
              <div className="sg-two">
                <div>
                  <Sub>Staff review: exact pin, read-only</Sub>
                  <MapPicker src={CAMPUS_MAP} width={MAP_WIDTH} height={MAP_HEIGHT} value={{ x: 0.84, y: 0.26 }} zones={DEMO_ZONES} readOnly label="Finder's pin" />
                </div>
                <div>
                  <Sub>Public listing: zone only, never the pin</Sub>
                  <MapPicker src={CAMPUS_MAP} width={MAP_WIDTH} height={MAP_HEIGHT} value={null} zones={DEMO_ZONES} highlightZoneId="z-library" readOnly label="Where it was found" />
                </div>
              </div>
              <Sub>Staff: location pin editor with zones and drop-off points</Sub>
              <ZoneEditorDemo />
            </div>
          )}
        />
      </Section>

      <Section id="photos" title="Photo capture" note="Slots, retake, remove, and status. The page resizes and uploads; this component calls back with files.">
        <Pair
          render={() => (
            <div className="sg-stack sg-phone">
              <PhotoCaptureDemo start="empty" />
              <PhotoCaptureDemo start="uploading" />
              <PhotoCaptureDemo start="full-error" />
            </div>
          )}
        />
      </Section>

      <Section id="confirm" title="Confirm action" note="Destructive actions take a second, deliberate step in a modal dialog. Focus starts on Cancel.">
        <Pair
          render={() => (
            <div className="sg-row">
              <ConfirmDemo />
              <ConfirmDemo fail />
              <BulkConfirmDemo />
              <PrimaryConfirmDemo />
            </div>
          )}
        />
      </Section>

      <Section id="data" title="Tables and lists" note="Dense and calm for staff. Captions name each table; wide tables scroll inside a focusable region.">
        <Pair
          render={() => (
            <div className="sg-stack">
              <Table caption="Review queue, flagged first">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Flags</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Waiting
                    </th>
                    <th scope="col" className="actions">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-selected="true">
                    <th scope="row">
                      <span className="with-icon">
                        <CategoryIcon category="bottle" size={18} />
                        Navy water bottle
                      </span>
                    </th>
                    <td>
                      <FlagChip flag="has_text" />
                    </td>
                    <td>
                      <StatusBadge kind="review" status="pending" />
                    </td>
                    <td className="num">2h</td>
                    <td className="actions">
                      <span className="button-row">
                        <Button size="sm" variant="primary" icon={<I.IconCheck />}>
                          Approve
                        </Button>
                        <Button size="sm" variant="danger-outline" icon={<I.IconX />}>
                          Reject
                        </Button>
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <span className="with-icon">
                        <CategoryIcon category="bag" size={18} />
                        Red backpack
                      </span>
                    </th>
                    <td>
                      <span className="muted">None</span>
                    </td>
                    <td>
                      <StatusBadge kind="review" status="pending" />
                    </td>
                    <td className="num">35m</td>
                    <td className="actions">
                      <span className="button-row">
                        <Button size="sm" variant="primary" icon={<I.IconCheck />}>
                          Approve
                        </Button>
                        <Button size="sm" variant="danger-outline" icon={<I.IconX />}>
                          Reject
                        </Button>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </Table>
              <Table caption="In custody" dense>
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Item</th>
                    <th scope="col">Custody</th>
                    <th scope="col">Public</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="mono">FCHS-M-000214</td>
                    <td>Navy water bottle</td>
                    <td>
                      <StatusBadge kind="custody" status="at_location" label="At Main Office" />
                    </td>
                    <td>
                      <StatusBadge kind="publication" status="published" />
                    </td>
                  </tr>
                  <tr>
                    <td className="mono">FCHS-M-000215</td>
                    <td>Red backpack</td>
                    <td>
                      <StatusBadge kind="custody" status="with_finder" />
                    </td>
                    <td>
                      <StatusBadge kind="publication" status="generating" />
                    </td>
                  </tr>
                </tbody>
              </Table>
              <Card title="Item details" titleLevel={3} actions={<StatusBadge kind="custody" status="at_location" label="At Main Office" />}>
                <KeyValue
                  items={[
                    { label: 'Item ID', value: <span className="mono">FCHS-M-000214</span> },
                    { label: 'Category', value: categoryLabel('bottle') },
                    { label: 'Found', value: 'Sep 29, 3:10 PM near Gym' },
                    { label: 'Location note', value: <span className="with-icon">C214 <PrivateNote /></span> },
                    { label: 'Keep until', value: 'Oct 29' },
                  ]}
                />
              </Card>
              <StatGrid label="This week">
                <Stat label="Waiting for review" value="7" hint="Oldest 2 hours" tone="warn" />
                <Stat label="Returned to owners" value="18" tone="ok" hint="Up 4 from last week" />
                <Stat label="In custody" value="31" />
                <Stat label="Never arrived" value="2" tone="danger" hint="Check with the finders" />
              </StatGrid>
            </div>
          )}
        />
      </Section>

      <Section id="feedback" title="Empty, loading, progress">
        <Pair
          render={() => (
            <div className="sg-stack">
              <EmptyState
                title="Nothing found yet today"
                actions={
                  <>
                    <LinkButton href="#feedback" variant="primary" icon={<I.IconSearch />}>
                      Report what you lost
                    </LinkButton>
                  </>
                }
              >
                New items show up here once staff check them in. Check back after lunch.
              </EmptyState>
              <EmptyState title="Queue is clear" icon={<I.IconCheckCircle />} headingLevel={3}>
                No items are waiting for review.
              </EmptyState>
              <Loading label="Loading found items">
                <ul className="item-grid">
                  {[1, 2, 3].map((n) => (
                    <li key={n}>
                      <SkeletonItemCard />
                    </li>
                  ))}
                </ul>
              </Loading>
              <div className="sg-row">
                <Skeleton circle width={40} height={40} />
                <div style={{ flex: 1 }}>
                  <SkeletonText lines={2} />
                </div>
              </div>
              <Progress label="Uploading photos" value={2} max={3} valueText="2 of 3 photos" />
              <Progress label="Checking photos" value={65} />
              <p className="sg-row small muted">
                <span className="spinner" aria-hidden="true" /> Spinner for inline waits
              </p>
            </div>
          )}
        />
      </Section>
    </main>
  );
}
