'use client';

import { Button } from '@/components/ui/button.tsx';
import { IconPrinter } from '@/components/ui/icons.tsx';

// The weekly report is the dashboard page itself, printed or saved as PDF from the browser (§17).
export function PrintButton() {
  return (
    <Button className="no-print" onClick={() => window.print()} icon={<IconPrinter />}>
      Print or save as PDF
    </Button>
  );
}
