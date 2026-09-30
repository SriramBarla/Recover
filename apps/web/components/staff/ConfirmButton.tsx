'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionError } from './ActionError.tsx';

type Props = {
  label: string;
  prompt: string;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => Promise<void>;
  children?: ReactNode; // optional extra fields shown in the confirm step (e.g. a reason select)
  confirmDisabled?: boolean;
};

// Two-step button: every destructive action shows an explicit confirm step first.
export function ConfirmButton({ label, prompt, confirmLabel = 'Confirm', danger = false, disabled, onConfirm, children, confirmDisabled }: Props) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<unknown>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (stage === 'confirm' && !children) confirmRef.current?.focus();
  }, [stage, children]);

  if (stage === 'idle') {
    return (
      <span className="stack" style={{ display: 'inline-block' }}>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn'}
          disabled={disabled}
          onClick={() => {
            setError(null);
            setStage('confirm');
          }}
        >
          {label}
        </button>
        <ActionError error={error} />
      </span>
    );
  }

  return (
    <div className="notice notice-warn stack" role="group" aria-label={prompt}>
      <p style={{ margin: 0, fontWeight: 600 }}>{prompt}</p>
      {children}
      <div className="row">
        <button
          ref={confirmRef}
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={stage === 'busy' || confirmDisabled}
          onClick={async () => {
            setStage('busy');
            try {
              await onConfirm();
              setStage('idle');
            } catch (e) {
              setError(e);
              setStage('idle');
            }
          }}
        >
          {stage === 'busy' ? 'Working...' : confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost" disabled={stage === 'busy'} onClick={() => setStage('idle')}>
          Cancel
        </button>
      </div>
    </div>
  );
}
