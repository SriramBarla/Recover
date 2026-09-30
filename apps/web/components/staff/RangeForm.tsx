import { Button } from '@/components/ui/button.tsx';
import { TextInput } from '@/components/ui/field.tsx';
import { IconCalendar } from '@/components/ui/icons.tsx';

// Date range for dashboards: a plain GET form so it works without JavaScript.
export function RangeForm({ from, to }: { from: string; to: string }) {
  return (
    <form method="get" className="row no-print" aria-label="Date range" style={{ alignItems: 'flex-end' }}>
      <TextInput id="range-from" label="From" type="date" name="from" defaultValue={from} required />
      <TextInput id="range-to" label="To" type="date" name="to" defaultValue={to} required />
      <Button type="submit" icon={<IconCalendar />}>
        Show
      </Button>
    </form>
  );
}
