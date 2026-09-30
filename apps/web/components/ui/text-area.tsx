'use client';
// TextArea with a live character counter. The visible counter updates on every keystroke; the
// spoken update waits until typing pauses so screen readers are not flooded (Appendix H).
// Works controlled (value + onChange) or uncontrolled (defaultValue). maxLength is enforced by
// the browser in UTF-16 units, which never exceeds the server's code-point limit.
import { useEffect, useRef, useState, type ChangeEvent, type TextareaHTMLAttributes } from 'react';
import { cx, describedBy } from './cx.ts';
import { Field, counterState, type FieldLabelProps } from './field.tsx';

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> &
  FieldLabelProps & {
    fieldClassName?: string;
    // Share of maxLength at which the counter turns to a warning (default 0.9).
    warnAt?: number;
  };

function remaining(left: number): string {
  if (left <= 0) return 'Character limit reached.';
  return left === 1 ? '1 character left.' : `${left} characters left.`;
}

export function TextArea({
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
  maxLength,
  warnAt = 0.9,
  value,
  defaultValue,
  onChange,
  ...rest
}: TextAreaProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => (defaultValue === undefined ? '' : String(defaultValue)));
  const text = controlled ? String(value ?? '') : inner;
  const count = text.length;
  const [spoken, setSpoken] = useState('');
  const typed = useRef(false);

  useEffect(() => {
    if (!maxLength || !typed.current) return;
    const t = setTimeout(() => setSpoken(remaining(maxLength - count)), 900);
    return () => clearTimeout(t);
  }, [count, maxLength]);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    typed.current = true;
    if (!controlled) setInner(e.target.value);
    onChange?.(e);
  }

  const state = maxLength ? counterState(count, maxLength, warnAt) : undefined;
  const counter = maxLength ? (
    <>
      <span aria-hidden="true">
        {count} / {maxLength}
      </span>
      <span className="visually-hidden">{`${count} of ${maxLength} characters used.`}</span>
    </>
  ) : null;

  return (
    <>
      <Field
        id={id}
        label={label}
        hint={hint}
        error={error}
        required={required}
        optional={optional}
        privateNote={privateNote}
        hideLabel={hideLabel}
        counter={counter}
        counterState={state}
        className={fieldClassName}
      >
        {(p) => (
          <textarea
            {...rest}
            {...p}
            className={cx('textarea', className)}
            aria-describedby={describedBy(p['aria-describedby'], rest['aria-describedby'])}
            aria-invalid={p['aria-invalid'] ?? rest['aria-invalid']}
            maxLength={maxLength}
            value={controlled ? text : undefined}
            defaultValue={controlled ? undefined : defaultValue}
            onChange={handleChange}
          />
        )}
      </Field>
      {maxLength ? (
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {spoken}
        </div>
      ) : null}
    </>
  );
}
