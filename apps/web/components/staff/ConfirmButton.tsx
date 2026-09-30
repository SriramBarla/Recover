'use client';

import type { ReactNode } from 'react';
import { ConfirmAction } from '@/components/ui/confirm-action.tsx';
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

// Two-step button: every destructive action shows an explicit confirm step first, as a modal dialog
// (design system ConfirmAction): focus starts on Cancel, Escape backs out, and a failed action keeps
// the dialog open with the error, including "Sign in again" when a step-up sign-in is needed.
export function ConfirmButton({ label, prompt, confirmLabel = 'Confirm', danger = false, disabled, onConfirm, children, confirmDisabled }: Props) {
  return (
    <ConfirmAction
      label={label}
      title={prompt}
      confirmLabel={confirmLabel}
      tone={danger ? 'danger' : 'primary'}
      triggerVariant={danger ? 'danger-outline' : 'secondary'}
      disabled={disabled}
      confirmDisabled={confirmDisabled}
      onConfirm={onConfirm}
      renderError={(e) => <ActionError error={e} />}
    >
      {children}
    </ConfirmAction>
  );
}
