# Recover design system

The visual language and shared UI for Recover: `apps/web/app/globals.css` (tokens and classes) and `apps/web/components/ui/**` (components). Open `/styleguide` in development to see every component in every state, in a light panel and a dark panel side by side. The page returns 404 in production.

Owner: design. Pages own their data and flows; this system owns how they look, read, and behave for keyboard and assistive technology users.

## 1. Principles

1. **Calm and trustworthy.** Warm paper neutrals, one deep teal brand, one warm accent. Nothing shouts except a real problem.
2. **Fast at dismissal.** Students are on phones, in a hurry, with one hand. The main action per screen is one big primary button. Targets are 44px. Words are plain ("Take it to the office", not "Submit high-value item").
3. **Dense but unambiguous for staff.** Staff screens are compact (`.compact`), but the school being acted on is always visible, every state has an icon and words, and destructive actions take a second, deliberate step.
4. **Private by default, and say so.** Any field only staff can see is marked "Only staff see this". Public screens never show the exact pin or the private note, only the zone name.
5. **Accessible by construction.** WCAG 2.2 AA is built into the components (labels, descriptions, focus, live regions, target sizes, contrast, reflow) so pages get it without extra work.
6. **Cheap to run.** Server components by default, pure CSS, inline SVG, system fonts. Client components only where there is real interaction.

## 2. Hard constraints

- **Accessibility.** WCAG 2.2 AA. Everything works by keyboard with a visible focus ring. Targets are at least 24px (44px on student pages). Pages reflow at 320px and 200% zoom. `prefers-reduced-motion` is honored. Status is never color alone.
- **Performance.** Student route JS must stay under 150 KB gzipped (15 section 18), so there are no UI libraries, no CSS frameworks, and no icon packages. The client components below add about 10 KB gzipped in total when all are used; the rest render on the server.
- **CSP** is `'self'` plus a nonce, so web fonts from CDNs are blocked. Inline `style` attributes are allowed (`style-src-attr 'unsafe-inline'`), and so are `data:` and `blob:` images.
- **No new npm packages.**

## 3. Identity

### 3.1 Logo

`LogoMark` is a lost-and-found tag, angled like it was just tied on, with a warm eyelet and a check (found, on its way back), on a rounded teal tile. `Logo` adds the "Recover" wordmark and an optional context label such as the school name.

```tsx
import { Logo, LogoMark } from '@/components/ui/logo.tsx';

<LogoMark size={30} />                 // decorative by default
<LogoMark size={48} title="Recover" /> // when it is the only label
<Logo context="Fairview High" />
```

The mark stays recognizable down to 24px; use 16px only where nothing else fits. Its colors come from `--logo-bg`, `--logo-fg`, and `--logo-accent`, which stay recognizably teal in dark mode.

### 3.2 Color

Tokens, never hex values, in components and pages. Light is the default. Dark follows `prefers-color-scheme`. `data-theme="light"` or `data-theme="dark"` forces a theme on any subtree (the styleguide uses this).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f6f4ef` | `#151412` | Page background (warm paper) |
| `--surface` | `#ffffff` | `#1e1d1a` | Cards, inputs, bars |
| `--surface-2` / `--surface-3` | `#efece5` / `#e5e1d8` | `#272622` / `#312f2a` | Sunken areas, hovers, table headers, skeletons |
| `--text` / `--muted` | `#1f1d1a` / `#5c5850` | `#efece5` / `#aaa598` | Body text / hints and metadata |
| `--border` / `--border-strong` | `#dedad0` / `#8a8377` | `#3a3833` / `#7c776d` | Dividers / control boundaries (3:1) |
| `--brand` | `#0f5c56` | `#5cc2b5` | Primary actions, links, selection |
| `--brand-soft` / `--brand-strong` | `#e0efec` / `#0b4a45` | `#173532` / `#8adbd0` | Tinted backgrounds / text on them |
| `--accent` (+ `-soft`, `-strong`, `-ink`) | `#c2501f` | `#f08a5d` | The one warm accent: map pin, new matches, counts, office-only tiles |
| `--ok`, `--warn`, `--danger` (+ `-soft`) | green, amber, red | lighter tints | Status tones, always with an icon and words |
| `--focus` | `#1f6feb` | `#79b8ff` | Focus ring only |

`--info` is an alias of the brand teal, which keeps the palette to one cool hue.

**Checked contrast pairs** (WCAG ratio, light / dark). Every text pair clears 4.5:1; control boundaries and the focus ring clear 3:1.

| Pair | Light | Dark |
|---|---|---|
| text on bg | 15.3 | 15.6 |
| muted on bg / surface / surface-2 | 6.4 / 7.1 / 6.0 | 7.5 / 6.9 / 6.2 |
| brand on bg (links) | 7.1 | 8.6 |
| brand-ink on brand (primary button) | 7.8 | 8.0 |
| brand-strong on brand-soft (badges, chips) | 8.5 | 8.3 |
| ok / warn / danger on their soft tints | 5.6 / 5.5 / 6.4 | 7.6 / 8.4 / 6.8 |
| accent-strong on accent-soft | 6.6 | 8.1 |
| accent-ink on accent (count bubble) | 4.7 | 7.2 |
| danger-ink on danger (danger button) | 7.8 | 8.1 |
| border-strong on surface (inputs) | 3.8 | 3.8 |
| focus on bg | 4.2 | 8.9 |

### 3.3 Type

The system font stack only (`--font`, `--mono`), with a 16px body at a 1.5 line height.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 12px | Card overlays, keycaps |
| `--text-sm` | 14px | Hints, metadata, dense tables |
| `--text-md` | 16px | Body, inputs (16px also stops iOS zoom-on-focus) |
| `--text-lg` | 18px | Empty-state and dialog titles |
| `--text-xl` | 22px | Section headings |
| `--text-2xl` | 24 to 30px, fluid | `h1` |
| `--text-3xl` | 30 to 40px, fluid | Marketing-size titles (styleguide only today) |

Use `.mono` for public IDs (`FCHS-M-000214`) and `.tabular` or `.num` for numbers that line up.

### 3.4 Space, radii, elevation, motion

- **Spacing** is a 4px scale: `--space-1` (4px) up to `--space-16` (64px). Layout helpers are `.stack`, `.stack-sm`, `.stack-lg`, `.stack-xl`, `.row`, `.spread`, `.button-row`, `.grid`, `.grid-wide`, `.item-grid`, `.item-list`, and `.tile-grid`.
- **Radii:** `--radius-xs` 4px (keycaps), `--radius-sm` 8px, `--radius-md` 10px (controls), `--radius` 12px (cards), `--radius-lg` 16px (dialogs), `--radius-xl` 24px, and `--radius-pill`.
- **Elevation:** `--shadow-sm`, `--shadow` (cards), and `--shadow-lg` (menus, dialogs, hovered cards). Dark mode leans on borders instead of shadows.
- **Motion:** `--dur-fast` 120ms, `--dur` 180ms, `--dur-slow` 280ms, and `--ease`. Under `prefers-reduced-motion: reduce`, all durations are 0 and all animations stop (spinners, skeleton shimmer, pin drop, dialog fade).

### 3.5 Density

Student pages use 44px controls (`--control-h`). Put `className="compact"` on the staff and district shell to get 36px controls and targets. That stays above the 24px WCAG floor, and the same components adapt.

## 4. Components

Import each from its file, for example `import { Button } from '@/components/ui/button.tsx'`. There is no barrel, so client bundles only carry what they import. **Shared** components have no hooks or handlers of their own: they render from server components and accept `onClick` inside client components. **Client** components start with `'use client'`.

| File | Exports | Kind |
|---|---|---|
| `button.tsx` | `Button`, `LinkButton`, `buttonClass` | shared |
| `card.tsx` | `Card` | shared |
| `badge.tsx` | `Badge`, `CountBadge`, `badgeClass`, `Tone` | shared |
| `chip.tsx` | `Chip`, `ChipLink`, `ChipButton`, `ChipGroup` | shared |
| `notice.tsx` | `Notice` | shared |
| `live-region.tsx` | `LiveRegion` | shared |
| `field.tsx` | `Field`, `Fieldset`, `TextInput`, `FieldError`, `PrivateNote`, `counterState` | shared |
| `text-area.tsx` | `TextArea` | client |
| `select.tsx` | `Select` | shared |
| `tile.tsx` | `TileLink`, `TileButton`, `TileRadio` | shared |
| `stepper.tsx` | `Stepper` | shared |
| `page-header.tsx` | `PageHeader` | shared |
| `top-nav.tsx` | `TopNav` (uses the client `NavLink` when `currentPath` is omitted) | shared |
| `nav-link.tsx` / `nav-path.ts` | `NavLink` / `isCurrentPath` | client / shared |
| `school-switcher.tsx` | `SchoolSwitcher` | shared (native `<details>`) |
| `sub-nav.tsx` | `SubNav` | shared |
| `empty-state.tsx` | `EmptyState` | shared |
| `skeleton.tsx` | `Skeleton`, `SkeletonText`, `SkeletonItemCard`, `Loading` | shared |
| `progress.tsx` | `Progress` | shared |
| `table.tsx` | `Table` | shared |
| `key-value.tsx` | `KeyValue` | shared |
| `stat.tsx` | `Stat`, `StatGrid` | shared |
| `kbd.tsx` | `Kbd` | shared |
| `category.tsx` | `CategoryIcon`, `categoryLabel`, `CATEGORY_LABEL`, `CATEGORY_SHORT`, `CATEGORY_HINT` | shared |
| `item-card.tsx` | `ItemCard`, `custodyLine` | shared |
| `status-badge.tsx` | `StatusBadge`, `statusLabel`, `FlagChip`, `flagKeys`, `FLAGS` | shared |
| `confirm-action.tsx` | `ConfirmAction` | client |
| `map-picker.tsx` / `map-geometry.ts` | `MapPicker` / `nearestZone`, `zoneBox`, map types | client / shared |
| `photo-capture.tsx` | `PhotoCapture` | client |
| `icons.tsx` | `Icon*` (57 icons), `IconProps` | shared |
| `logo.tsx` | `LogoMark`, `Logo` | shared |

A function exported from a `'use client'` file is only a reference on the server, so helpers pages may call server-side live in plain modules (`nav-path.ts`, `map-geometry.ts`, `field.tsx`).

### 4.1 Buttons

```tsx
<Button variant="primary" size="lg" block icon={<IconCamera />}>Take photo</Button>
<LinkButton href={`/s/${code}/lost`} size="lg" block icon={<IconSearch />}>I lost something</LinkButton>
<Button variant="danger-outline" size="sm" icon={<IconTrash />}>Dispose</Button>
<Button iconOnly aria-label="Search" icon={<IconSearch />} />
<Button variant="primary" type="submit" loading={busy} loadingText="Sending...">Send report</Button>
```

- **Variants:** `primary` (one per view), `secondary` (default), `ghost`, `danger` (the confirming step of a destructive action), and `danger-outline` (a destructive trigger in a list).
- **Sizes:** `sm` 32px, `md` 44px, `lg` 52px. `.compact` lowers them to 28, 36, and 44px.
- **`type` defaults to `button`.** Pass `type="submit"` in forms.
- **`loading`** keeps the button focusable, shows a spinner, and sets `aria-busy` and `aria-disabled`. Your handler must ignore presses while busy, because keyboard presses still fire click.

### 4.2 Forms

The order is label, hint, error, then control. `Field` hands the control its ids; `TextInput`, `TextArea`, and `Select` do it for you.

```tsx
<TextInput id="note" label="Location note" hint="For example C214." maxLength={80} optional privateNote />
<TextArea id="desc" label="Describe it" hint="Color, brand, anything that stands out." maxLength={120} value={v} onChange={(e) => setV(e.target.value)} />
<Select id="dropoff" label="Drop-off location" placeholder="Choose a location" options={locations.map((l) => ({ value: l.id, label: l.name }))} error={errors.dropoff} />
```

- `aria-describedby` lists the error, hint, private note, and counter, in that order. `aria-invalid` is set when there is an error. Errors get a spoken "Error:" prefix and an icon.
- `privateNote` shows the "Only staff see this" pill (lock icon), and the control's description includes it.
- Mark optional fields with `optional`; do not star required ones.
- `TextArea` counts visibly on every keystroke and speaks "N characters left" after typing pauses. It never announces on page load. `maxLength` is enforced in UTF-16 units, which never exceeds the server's code-point limit.
- `Fieldset` groups radios, checkboxes, and tiles under one legend, with the description on the fieldset.
- Layout helpers for settings forms:
  - `label.choice` is a checkbox or radio row with a 44px target. `.choice-grid` (as `bodyClassName`) sets several choices side by side, and `p.hint.choice-hint` lines a hint up under the choice above it (point the input's `aria-describedby` at it).
  - `.input-number` keeps number inputs short, `bodyClassName="fieldset-row"` sets short fields side by side, and `.field-measure` caps a long text field at the reading measure.
  - When one field in a row has a hint, add `.fields-align-end` to the grid so the inputs line up.
  - File inputs (`TextInput type="file"`) style the picker button like a secondary button.

### 4.3 Tiles (category step)

```tsx
<ul className="tile-grid">
  {STUDENT_CATEGORIES.map((c) => (
    <li key={c}>
      <TileButton icon={<CategoryIcon category={c} />} label={categoryLabel(c)} description={CATEGORY_HINT[c]} onClick={() => choose(c)} />
    </li>
  ))}
</ul>
```

Tiles are at least 100px tall, with an icon, plain words, and examples. Pass `accent` for the office-only group (phone, wallet, keys, ID, medication). `TileRadio` is a real radio for forms. Selected tiles show a check and a heavier border, so selection is not color alone.

### 4.4 Status: badges, status badges, flags, notices

- `Badge tone="neutral|brand|info|ok|warn|danger|accent"`: always include words.
- `StatusBadge kind status` is one vocabulary for every state machine, with an icon and words for each state:
  - **review:** Draft, Needs review, Approved, Rejected.
  - **publication:** Not public, Publishing, Public, Withdrawn.
  - **custody:** With finder, In custody, Claimed, Donated, Disposed, Never arrived.
  - **report, map, member, and screening** follow the same pattern.
  - `label` overrides the words ("At West Campus"). `context` adds a spoken "Custody:" prefix where there is no column header.
- `FlagChip flag` names queue flags in staff words, including `ceiling`, `unscreened`, and `hold`; unknown flags render neutral. `flagKeys(item.flags, item.screeningStatus)` gives the list a card shows.
- `Notice tone="info|success|warning|danger"` has a distinct icon shape per tone and a spoken prefix. Use `live="polite"` for status that changes after load (keep it mounted and change its text). Reserve `live="assertive"` for errors that block the task.
- `CountBadge count label` is the accent count bubble with a spoken label ("3 new matches"). New matches are good news, so they use accent, never warn.

### 4.5 Navigation and page structure

```tsx
// Student layout
<TopNav homeHref={`/s/${code}`} brandContext={school.name} items={[
  { href: `/s/${code}`, label: 'Found items', match: 'exact' },
  { href: `/s/${code}/lost/mine`, label: 'Your reports', count: newMatches, countLabel: 'new matches' },
]} />

// Staff layout: the school is always the most prominent thing in the bar
<TopNav className="compact" homeHref="/staff"
  context={<SchoolSwitcher current={{ code, name }} schools={mySchools} allHref="/staff" />}
  items={sections} end={<SignOutButton />} />

<main id="main" className="container">
  <PageHeader eyebrow={`${school.name} · ${code}`} title="Custody" description="..." actions={...} back={{ href, label }} />
  <SubNav label="Custody views" current={view} items={[...]} />
```

- `TopNav` sets `aria-current="page"` itself. In layouts, omit `currentPath` and each link resolves from `usePathname()`. In a page you can pass `currentPath`. The brand link goes through `NavLink match="never"`, so the shell never renders `next/link` from a server component (see the JS budget in section 7).
- `SchoolSwitcher` is a native `<details>` disclosure (no JavaScript). District pages pass `label="District"`.
- Keep one `h1` per page (from `PageHeader`) and `<main id="main">` so the root layout's skip link works. In a client wizard, move focus to the new step's heading on each step change (`PageHeader focusableTitle`, or your own `tabIndex={-1}` heading).
- `Stepper steps current` prints "Step 2 of 5 · Photos" as the accessible text. The segmented bar is hidden from assistive technology, and the current segment is half-filled.

### 4.6 Item cards

```tsx
<ul className="item-grid">
  {items.map((item, i) => (
    <li key={item.id}>
      <ItemCard href={`/s/${code}/items/${item.publicId}`} publicId={item.publicId} category={item.category}
        description={item.description} photo={item.photos[0] ? { url: item.photos[0].thumbUrl } : null}
        zoneName={item.zoneName} custody={item.custody} locationName={names[item.locationId]}
        foundLabel={`Found ${formatDay(item.foundAt, tz)}`} priority={i < 4} />
    </li>
  ))}
</ul>
```

- The thumb is a fixed 1:1 box with explicit `width` and `height`, so there is no layout shift. Pass `priority` only for the first row (the LCP image).
- The description is the link, and a stretched link makes the whole card clickable with one focus ring. **Never wrap a card, an `<article>`, or any landmark in `<a>`**, because Chrome then computes no accessible name for the link.
- Buttons go in `actions`, which sits above the stretched link (for example "This is it" and "View listing" on lost-report matches). `status` holds badges. `custodyLabel` replaces the custody line ("At another school (SFHS)").
- The custody line reads "Being brought to {location}" (clock icon) or "At {location}" (building icon, green, bold). The zone line reads "Found near {zone}". Public cards never get a pin.
- `variant="row"` gives a horizontal card for matches and staff lists. `.item-grid` gives two columns from 320px.

### 4.7 Destructive actions

```tsx
<ConfirmAction
  label="Dispose" triggerIcon={<IconTrash />}
  title={`Dispose ${item.publicId}?`}
  description="Record that this item was thrown away. Its listing and photos are removed. This cannot be undone."
  confirmLabel="Dispose item"
  onConfirm={() => dispose(item)}
  renderError={(e) => <ActionError error={e} />}
/>
```

- A modal `<dialog>` gives a native focus trap and closes on Escape. Focus starts on **Cancel**, so a double Enter cannot confirm. The confirm button repeats the verb.
- Extra fields (a reject reason) go in `children`, gated by `confirmDisabled`. `acknowledge` adds a required checkbox for bulk or physical actions ("I have disposed of these 12 items").
- A rejected `onConfirm` keeps the dialog open and shows the error inline. `renderError` lets staff show "Sign in again" for step-up.
- Without `onConfirm`, the confirm button submits the form named by `form`, `name`, and `value` (for server actions).

### 4.8 Map picker

```tsx
<MapPicker src={map.url} width={map.width} height={map.height} value={pin}
  onChange={(p, zone) => setPin(p)} zones={zones} clearable label="Where did you find it?" />
<MapPicker src={map.url} width={map.width} height={map.height} value={null} zones={zones} highlightZoneName={item.zoneName} readOnly /> // public
<MapPicker src={`/api/staff/${code}/maps/${id}/image`} value={item.pin} zones={zones} readOnly label="Finder's pin" />                 // staff, size unknown
```

- The map is a plain `<img>` (no map library, 15 section 18) with overlays positioned in percent. Coordinates are normalized 0..1.
- **Pointer:** click or tap places the pin.
- **Keyboard:** focus the map, arrow keys move a crosshair (Shift moves 5x), Enter or Space places the pin, and Delete clears it when `clearable`.
- **Fallback:** a visible zone `<select>` places the pin at the zone center.
- **Announcements:** placement is announced at once ("Pin placed near Gym"); crosshair moves are announced after a pause.
- `nearestZone` mirrors `private.resolve_zone` (aspect-scaled radius).
- **Privacy:** public listings pass `highlightZoneName` (the public DTO has only the zone name) or `highlightZoneId`, never a pin; staff review may pass the exact pin. `showZones` and `markers` serve the staff zone and location editors.
- `width` and `height` may be null (older map versions); the picker then sizes from the loaded image.
- **Staff editors:** `coordinateInputs` adds typed Across (%) and Down (%) fields with a "Set {pointLabel}" button, and `showCoordinates` adds the numbers to the readout. Markers are also listed for screen readers.
- The found wizard loads the picker with `React.lazy` (it is only needed on the "where" step) and starts fetching it on the photos step. Keep new map features out of the student path when they are staff-only.

### 4.9 Photo capture

```tsx
<PhotoCapture photos={photos} error={err}
  onAdd={(files) => addResized(files)} onReplace={(i, f) => replaceResized(i, f)}
  onRemove={(i) => removeAndRepack(i)} onRetry={(i) => retryUpload(i)} />
```

- Presentational only. The page keeps resizing (`toJpeg`), `blob:` previews (revoke them), and uploads.
- Up to 3 slots. The next empty slot is the "Take photo" or "Add photo" button. Each photo has Retake and Remove (icon-only on phones, with the names still spoken).
- The status overlay shows Preparing, Uploading NN%, Uploaded, or Failed with Retry.
- Focus returns to the slot after a change, and add, remove, and replace are announced politely.

### 4.10 Data: tables, lists, stats, empty and loading

- `Table caption dense hideCaption` wraps your `thead` and `tbody` in a labelled, focusable scroll region, so wide tables scroll without a mouse at 320px. Cells take `className="num"` or `"actions"`, and rows take `data-selected` or `aria-current="true"`.
  - Cells wrap at word boundaries only. A table wider than the screen scrolls inside its region, and a soft shadow (`--scroll-shadow`) shows on the side that has more columns.
  - Put several text links in one cell with `div.link-row`, and an action cell's buttons in `div.button-row`.
- `KeyValue items` renders a two-column `dl` that stacks under 30rem.
- `StatGrid` and `Stat label value hint tone` render KPI tiles. The `hint` says what the tone means.
- `EmptyState title actions` is for an empty list: what it means and what to do next.
- `Loading label` wraps `SkeletonItemCard` or `Skeleton` and announces one "Loading ..." instead of every shape.
- `Progress label value max valueText` is a labelled native `<progress>`. Announce milestones through a `LiveRegion`, not every percent.
- `Kbd` renders keycaps for shortcut hints, next to buttons that do the same thing.

### 4.11 Icons

58 hand-drawn outline icons on a 24px grid with 1.75px round strokes, using `currentColor`:

- **Categories:** bag, bottle, book, clothing, electronics, jewelry, sports, other, phone, wallet, keys, id, medication.
- **Actions and objects:** search, camera, map-pin, check, x, alert, clock, building, user, shield, and more.

Icons are decorative (`aria-hidden`) unless `title` is given. `CategoryIcon category` and `categoryLabel(c)` cover every category.

## 5. Accessibility checklist for pages

- One `h1` per page, `<main id="main">`, and landmarks labelled when repeated (`nav aria-label`).
- Every control has a visible label. Icon-only buttons have an `aria-label` that contains the visible or implied verb.
- Focus is always visible (3px `--focus` ring, offset 2px). Nothing removes it.
- There are no positive `tabindex` values. Wizards move focus to the step heading on change.
- Status uses icon and words (`StatusBadge`, `Notice`). Selection uses a check or weight, never only a color.
- Live regions are mounted once and updated. Use polite for progress and placement; assertive only for blocking errors.
- At 320px nothing scrolls sideways except inside `Table`. Grid and flex children use `min-width: 0`, and long ids and emails wrap.
- Destructive actions use `ConfirmAction`. Shortcut keys always have a button too.
- Photos: in cards the image is decorative (the description is the link). On the listing, use short alt text such as "Photo 1 of 3 of the water bottle".

## 6. Legacy classes and the phase-2 swap

Every class in `globals.css` stays supported, restyled with the tokens. They are a public API, so they can be extended but never renamed or removed. Pages written with raw classes already look right; the polish pass swaps markup for components:

| Raw markup today | Component |
|---|---|
| `a.btn.btn-primary`, `button.btn` | `LinkButton`, `Button` |
| `.field` + `.label` + `.input` + `.hint` + `.field-error` | `TextInput` (or `Field`) |
| `.textarea` + hand-rolled count | `TextArea maxLength` |
| `.select` | `Select` |
| `ol.steps` + "Step n of m" text | `Stepper` |
| `.badge.badge-*` for states | `StatusBadge` / `FlagChip` |
| `.notice.notice-*` | `Notice` |
| `header.topbar` + `.brand` + `.nav` | `TopNav` (+ `SchoolSwitcher` for staff) |
| `a.card-link > .card.item-card` | `ItemCard` (the link lives on the title) |
| `.table-wrap > table.table` | `Table caption` |
| `.kpis > .kpi` | `StatGrid` / `Stat` |
| `.map-frame` + `.map-pin` + `.map-crosshair` | `MapPicker` |
| `.photo-slots` + `.photo-slot` | `PhotoCapture` |
| Inline two-step confirm | `ConfirmAction` |
| `<kbd>` | `Kbd` |

## 7. Changing the system

- Add tokens, not hex values. Add a dark value for every color token in both dark blocks of `globals.css` (the media query and `[data-theme='dark']`), and check the contrast pairs in section 3.2.
- A new component goes in `components/ui/`: typed props, server-safe unless it needs state, and a specimen in `/styleguide` in both panels.
- **Student JS budget.** Every student route stays under 150 KB of gzipped first-load JS. React and the Next.js runtime already take about 128 KB, so every client import on a student page counts. Measure the scripts a production build actually sends for the page, not the source size.
  - Do not render `next/link` from a server component that appears on every page, such as a not-found boundary or the shell. Its client reference can pull another page's chunks into every route. Use `<a className={buttonClass(...)}>` there, or a client component that is already in the shell (`NavLink`).
  - Load step-specific tools with `React.lazy` and `Suspense`, with a skeleton fallback and a notice if loading fails. The found wizard does this for the map and the photo tools.
  - `.with-icon` text wraps beside its icon, so long school and location names never widen the page at 320px.
- Verify with a typecheck, then `/styleguide` in light, dark, 360px, and 320px (no sideways scroll), then keyboard-only use of any interactive change.
