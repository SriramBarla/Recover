'use client';
// Degraded mode (§16.2): when the database or a dependency fails, point students to the office.
import { useEffect } from 'react';
import { reportClientError } from '@/components/student/client-api.ts';
import { Button } from '@/components/ui/button.tsx';
import { IconRefresh } from '@/components/ui/icons.tsx';

export default function StudentError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportClientError('render_error');
  }, [error]);
  return (
    <div className="container-narrow stack" role="alert">
      <h1>Recover is having trouble right now</h1>
      <p>If you found something, take it to the front office. If you lost something, ask at the front office.</p>
      <p>
        <Button onClick={() => retry()} icon={<IconRefresh />}>
          Try again
        </Button>
      </p>
    </div>
  );
}
