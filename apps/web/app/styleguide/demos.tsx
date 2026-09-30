'use client';
// Interactive specimens for the styleguide. They show how pages wire the client components;
// nothing here is imported by product pages.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { ChipButton, ChipGroup } from '@/components/ui/chip.tsx';
import { CategoryIcon, categoryLabel } from '@/components/ui/category.tsx';
import { ConfirmAction } from '@/components/ui/confirm-action.tsx';
import { IconTrash } from '@/components/ui/icons.tsx';
import { MapPicker, type MapPoint, type MapZone } from '@/components/ui/map-picker.tsx';
import { PhotoCapture, type CapturedPhoto } from '@/components/ui/photo-capture.tsx';
import { TextArea } from '@/components/ui/text-area.tsx';
import { TileButton } from '@/components/ui/tile.tsx';
import { CAMPUS_MAP, DEMO_MARKERS, DEMO_ZONES, MAP_HEIGHT, MAP_WIDTH, PHOTO_BACKPACK, PHOTO_BOTTLE, PHOTO_HOODIE } from './assets.ts';

export function LoadingButtonDemo() {
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <Button
      variant="primary"
      loading={busy}
      loadingText="Sending..."
      onClick={() => {
        if (busy) return;
        setBusy(true);
        timer.current = setTimeout(() => setBusy(false), 1800);
      }}
    >
      Send report
    </Button>
  );
}

export function ChipToggleDemo() {
  const [on, setOn] = useState<string[]>(['bag']);
  const cats = ['bag', 'bottle', 'clothing', 'electronics_low'];
  return (
    <ChipGroup label="Filter by category">
      {cats.map((c) => (
        <ChipButton
          key={c}
          pressed={on.includes(c)}
          icon={<CategoryIcon category={c} size={16} />}
          onClick={() => setOn((v) => (v.includes(c) ? v.filter((x) => x !== c) : [...v, c]))}
        >
          {categoryLabel(c, true)}
        </ChipButton>
      ))}
    </ChipGroup>
  );
}

export function TileToggleDemo() {
  const [picked, setPicked] = useState<string | null>('bottle');
  return (
    <ul className="tile-grid">
      {['bag', 'bottle', 'clothing'].map((c) => (
        <li key={c}>
          <TileButton
            icon={<CategoryIcon category={c} />}
            label={categoryLabel(c)}
            pressed={picked === c}
            onClick={() => setPicked(c)}
          />
        </li>
      ))}
    </ul>
  );
}

export function TextAreaDemo({ id }: { id: string }) {
  const [text, setText] = useState('Navy metal water bottle with a dent near the lid and three stickers on the side, one of a');
  return (
    <TextArea
      id={id}
      label="Describe it"
      hint="What it is, color, anything that stands out. Do not include names."
      maxLength={120}
      rows={3}
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

export function MapPickerDemo({ clearable = true }: { clearable?: boolean }) {
  const [pin, setPin] = useState<MapPoint | null>({ x: 0.2, y: 0.33 });
  const [zone, setZone] = useState<MapZone | null>(null);
  return (
    <div className="stack">
      <MapPicker
        src={CAMPUS_MAP}
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        value={pin}
        zones={DEMO_ZONES}
        clearable={clearable}
        label="Campus map: where did you find it?"
        onChange={(v, z) => {
          setPin(v);
          setZone(z);
        }}
      />
      <p className="small muted">
        onChange value: <span className="mono">{pin ? `{ x: ${pin.x}, y: ${pin.y} }` : 'null'}</span>
        {zone ? `, zone: ${zone.name}` : ''}
      </p>
    </div>
  );
}

export function ZoneEditorDemo() {
  const [pin, setPin] = useState<MapPoint | null>(null);
  return (
    <MapPicker
      src={CAMPUS_MAP}
      width={MAP_WIDTH}
      height={MAP_HEIGHT}
      value={pin}
      zones={DEMO_ZONES}
      showZones
      markers={DEMO_MARKERS}
      clearable
      label="Campus map: place the location pin"
      help="Click where the drop-off desk is. Zones and existing locations are shown for reference."
      zoneSelectLabel="Or snap to a zone center"
      onChange={(v) => setPin(v)}
    />
  );
}

type DemoPhoto = CapturedPhoto & { owned?: boolean };

export function PhotoCaptureDemo({ start }: { start: 'empty' | 'uploading' | 'full-error' }) {
  const initial: DemoPhoto[] =
    start === 'empty'
      ? []
      : start === 'uploading'
        ? [
            { key: 'a', previewUrl: PHOTO_BOTTLE, status: 'uploaded' },
            { key: 'b', previewUrl: PHOTO_BACKPACK, status: 'uploading', progress: 45 },
          ]
        : [
            { key: 'a', previewUrl: PHOTO_BOTTLE, status: 'ready' },
            { key: 'b', previewUrl: PHOTO_HOODIE, status: 'error', error: 'Upload failed' },
            { key: 'c', previewUrl: PHOTO_BACKPACK, status: 'ready' },
          ];
  const [photos, setPhotos] = useState<DemoPhoto[]>(initial);
  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(
    () => () => {
      for (const p of photosRef.current) if (p.owned) URL.revokeObjectURL(p.previewUrl);
    },
    [],
  );
  return (
    <PhotoCapture
      photos={photos}
      error={start === 'full-error' ? 'Photo 2 did not upload. Retry it or remove it.' : undefined}
      onAdd={(files) =>
        setPhotos((ps) => [
          ...ps,
          ...files.map((f, i) => ({ key: `${Date.now()}-${i}`, previewUrl: URL.createObjectURL(f), status: 'ready' as const, owned: true })),
        ])
      }
      onReplace={(index, f) =>
        setPhotos((ps) =>
          ps.map((p, i) => {
            if (i !== index) return p;
            if (p.owned) URL.revokeObjectURL(p.previewUrl);
            return { key: `${Date.now()}`, previewUrl: URL.createObjectURL(f), status: 'ready', owned: true };
          }),
        )
      }
      onRemove={(index) =>
        setPhotos((ps) => {
          const gone = ps[index];
          if (gone?.owned) URL.revokeObjectURL(gone.previewUrl);
          return ps.filter((_, i) => i !== index);
        })
      }
      onRetry={(index) => setPhotos((ps) => ps.map((p, i) => (i === index ? { ...p, status: 'uploading', progress: 10 } : p)))}
    />
  );
}

export function ConfirmDemo({ fail = false }: { fail?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="button-row">
      <ConfirmAction
        label={fail ? 'Dispose (fails)' : 'Dispose'}
        triggerIcon={<IconTrash size={18} />}
        title="Dispose FCHS-M-000214?"
        description="Record that this item was thrown away. Its public listing and photos are removed. This cannot be undone."
        confirmLabel="Dispose item"
        onConfirm={() =>
          new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              if (fail) {
                reject(new Error('The item changed since you opened it. Reload and try again.'));
                return;
              }
              setDone(true);
              resolve();
            }, 900);
          })
        }
      />
      {done ? <span className="small muted">Disposed (demo).</span> : null}
    </div>
  );
}

export function BulkConfirmDemo() {
  return (
    <ConfirmAction
      label="Dispose 12 items"
      triggerVariant="danger"
      title="Dispose 12 items?"
      description="All 12 selected items are past their retention date. Their listings and photos are removed."
      confirmLabel="Dispose 12 items"
      acknowledge="I have physically donated or disposed of these 12 items."
      onConfirm={() => new Promise<void>((r) => setTimeout(r, 700))}
    />
  );
}

export function PrimaryConfirmDemo() {
  return (
    <ConfirmAction
      label="Mark as claimed"
      tone="primary"
      triggerVariant="primary"
      title="Hand FCHS-M-000214 to its owner?"
      description="Only mark it claimed after checking a detail that is not in the listing, like what is inside or a hidden mark."
      confirmLabel="Mark as claimed"
      onConfirm={() => new Promise<void>((r) => setTimeout(r, 700))}
    />
  );
}
