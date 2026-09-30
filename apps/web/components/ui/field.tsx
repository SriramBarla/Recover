// Form field wiring. Field renders label, hint, error, private note, and counter, and hands the
// control the ids it must reference: aria-describedby (error, hint, private note, counter, in
// that order) and aria-invalid. Order on screen follows GOV.UK: label, hint, error, control.
// Shared component: works in server forms and inside client components.
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx, describedBy } from './cx.ts';
import { IconAlertCircle, IconLock } from './icons.tsx';

export const PRIVATE_NOTE = 'Only staff see this';

export type ControlProps = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: boolean;
};

export function fieldIds(id: string) {
  return { hint: `${id}-hint`, error: `${id}-error`, counter: `${id}-counter`, private: `${id}-private` };
}

export type FieldLabelProps = {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  // Marks the field "(optional)". Recover marks optional fields rather than required ones.
  optional?: boolean;
  // true shows "Only staff see this"; a node replaces the wording.
  privateNote?: boolean | ReactNode;
  hideLabel?: boolean;
};

export type FieldProps = FieldLabelProps & {
  counter?: ReactNode;
  // Colors the counter: 'near' warns, 'full' means the limit is reached.
  counterState?: 'ok' | 'near' | 'full';
  className?: string;
  children: (control: ControlProps) => ReactNode;
};

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className="field-error" id={id}>
      <IconAlertCircle size={18} />
      <span>
        <span className="visually-hidden">Error: </span>
        {children}
      </span>
    </p>
  );
}

export function PrivateNote({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <span className="field-private" id={id}>
      <IconLock size={14} />
      {children ?? PRIVATE_NOTE}
    </span>
  );
}

export function Field({ id, label, hint, error, required, optional, privateNote, hideLabel, counter, counterState, className, children }: FieldProps) {
  const ids = fieldIds(id);
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const desc = describedBy(hasError && ids.error, hint ? ids.hint : null, privateNote ? ids.private : null, counter ? ids.counter : null);
  return (
    <div className={cx('field', className)}>
      <div className="label-row">
        <label className={cx('label', hideLabel && 'visually-hidden')} htmlFor={id}>
          {label}
          {optional ? <span className="label-optional"> (optional)</span> : null}
        </label>
        {privateNote ? <PrivateNote id={ids.private}>{privateNote === true ? undefined : privateNote}</PrivateNote> : null}
      </div>
      {hint ? (
        <p className="hint" id={ids.hint}>
          {hint}
        </p>
      ) : null}
      {hasError ? <FieldError id={ids.error}>{error}</FieldError> : null}
      {children({ id, 'aria-describedby': desc, 'aria-invalid': hasError ? true : undefined, required })}
      {counter ? (
        <div className="field-counter" id={ids.counter} data-state={counterState}>
          {counter}
        </div>
      ) : null}
    </div>
  );
}

// Fieldset: a labelled group (radios, checkboxes, choice tiles). The description ids go on the
// fieldset so screen readers read them when entering the group.
export function Fieldset({
  id,
  legend,
  hint,
  error,
  optional,
  privateNote,
  hideLegend,
  className,
  bodyClassName,
  children,
}: {
  id: string;
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  privateNote?: boolean | ReactNode;
  hideLegend?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const ids = fieldIds(id);
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  return (
    <fieldset
      id={id}
      className={cx('fieldset', className)}
      aria-describedby={describedBy(hasError && ids.error, hint ? ids.hint : null, privateNote ? ids.private : null)}
      aria-invalid={hasError ? true : undefined}
    >
      <legend className={cx(hideLegend && 'visually-hidden')}>
        {legend}
        {optional ? <span className="label-optional"> (optional)</span> : null}
      </legend>
      {privateNote ? <PrivateNote id={ids.private}>{privateNote === true ? undefined : privateNote}</PrivateNote> : null}
      {hint ? (
        <p className="hint" id={ids.hint}>
          {hint}
        </p>
      ) : null}
      {hasError ? <FieldError id={ids.error}>{error}</FieldError> : null}
      <div className={cx('fieldset-body', bodyClassName)}>{children}</div>
    </fieldset>
  );
}

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> &
  FieldLabelProps & {
    fieldClassName?: string;
  };

export function TextInput({
  id,
  label,
  hint,
  error,
  required,
  optional,
  privateNote,
  hideLabel,
  fieldClassName,
  className,
  type = 'text',
  ...input
}: TextInputProps) {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      privateNote={privateNote}
      hideLabel={hideLabel}
      className={fieldClassName}
    >
      {(p) => (
        <input
          {...input}
          {...p}
          type={type}
          className={cx('input', className)}
          aria-describedby={describedBy(p['aria-describedby'], input['aria-describedby'])}
        />
      )}
    </Field>
  );
}
