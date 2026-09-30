// Select: a native <select> with Field wiring and a drawn chevron. Native keeps mobile pickers,
// type-ahead, and screen reader support for free.
import type { SelectHTMLAttributes } from 'react';
import { cx, describedBy } from './cx.ts';
import { Field, type FieldLabelProps } from './field.tsx';
import { IconChevronDown } from './icons.tsx';

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> &
  FieldLabelProps & {
    options?: readonly SelectOption[];
    // Adds a first empty option, for example "Choose a location".
    placeholder?: string;
    fieldClassName?: string;
  };

export function Select({
  id,
  label,
  hint,
  error,
  required,
  optional,
  privateNote,
  hideLabel,
  options,
  placeholder,
  fieldClassName,
  className,
  children,
  ...select
}: SelectProps) {
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
        <span className="select-wrap">
          <select
            {...select}
            {...p}
            className={cx('select', className)}
            aria-describedby={describedBy(p['aria-describedby'], select['aria-describedby'])}
            aria-invalid={p['aria-invalid'] ?? select['aria-invalid']}
          >
            {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
            {options?.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
            {children}
          </select>
          <IconChevronDown className="select-chevron" size={18} />
        </span>
      )}
    </Field>
  );
}
