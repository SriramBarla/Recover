'use client';
// ConfirmAction: a destructive action takes two deliberate steps. The trigger opens a modal
// <dialog> (native focus trap, Escape cancels) that names the consequence; focus starts on
// Cancel, and the confirm button repeats the verb ("Dispose item"). An optional checkbox
// (`acknowledge`) must be ticked first, for bulk or irreversible actions.
// Two ways to act: `onConfirm` (may return a promise; its error is shown in the dialog), or no
// onConfirm and `form`/`name`/`value`, which makes the confirm button submit that form.
import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from './button.tsx';
import { IconAlert, IconInfo } from './icons.tsx';

export type ConfirmActionProps = {
  label: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm?: () => void | Promise<unknown>;
  form?: string;
  name?: string;
  value?: string;
  acknowledge?: ReactNode;
  tone?: 'danger' | 'primary';
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
  children?: ReactNode;
};

export function ConfirmAction({
  label,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  form,
  name,
  value,
  acknowledge,
  tone = 'danger',
  triggerVariant,
  triggerSize = 'md',
  triggerIcon,
  triggerClassName,
  disabled = false,
  children,
}: ConfirmActionProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acked, setAcked] = useState(false);
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const ackId = `${id}-ack`;

  function open() {
    setError(null);
    setAcked(false);
    const d = dialogRef.current;
    if (!d) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    cancelRef.current?.focus();
  }

  function close() {
    dialogRef.current?.close();
  }

  function restoreFocus() {
    // Browsers return focus to the trigger on close; this covers the ones that do not.
    if (document.activeElement === document.body) triggerRef.current?.focus();
  }

  async function confirm() {
    if (pending || (acknowledge && !acked)) return;
    if (!onConfirm) {
      close();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'That did not work. Try again.');
    } finally {
      setPending(false);
    }
  }

  const blocked = Boolean(acknowledge) && !acked;

  return (
    <>
      <Button
        ref={triggerRef}
        variant={triggerVariant ?? (tone === 'danger' ? 'danger-outline' : 'secondary')}
        size={triggerSize}
        icon={triggerIcon}
        className={triggerClassName}
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={open}
      >
        {label}
      </Button>
      <dialog
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onClose={restoreFocus}
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <div className="dialog-body">
          <span className="dialog-icon" data-tone={tone} aria-hidden="true">
            {tone === 'danger' ? <IconAlert size={22} /> : <IconInfo size={22} />}
          </span>
          <div>
            <h2 className="dialog-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="dialog-text" id={descId}>
                {description}
              </p>
            ) : null}
          </div>
          {children || acknowledge || error ? (
            <div className="dialog-extra stack-sm">
              {children}
              {acknowledge ? (
                <label className="choice" htmlFor={ackId}>
                  <input id={ackId} type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
                  <span>{acknowledge}</span>
                </label>
              ) : null}
              {error ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="dialog-actions">
          <Button ref={cancelRef} variant="secondary" onClick={close} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            type={onConfirm ? 'button' : 'submit'}
            form={onConfirm ? undefined : form}
            name={onConfirm ? undefined : name}
            value={onConfirm ? undefined : value}
            loading={pending}
            aria-disabled={blocked ? true : undefined}
            onClick={(e) => {
              if (blocked) {
                e.preventDefault();
                return;
              }
              void confirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </>
  );
}
