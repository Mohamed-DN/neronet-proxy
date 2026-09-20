import { forwardRef } from 'react';

import { cn } from './cn';
import { useField } from './FormField';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Draws the value in the mono face: addresses, keys, identifiers. */
  mono?: boolean;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono = false, invalid, id, 'aria-describedby': describedBy, required, ...props },
  ref
) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <input
      ref={ref}
      id={id ?? field?.controlId}
      aria-describedby={describedBy ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      required={required ?? field?.required}
      className={cn(
        'h-9 w-full rounded-control border bg-surface-raised px-3 text-body text-content',
        'placeholder:text-subtle focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-subtle',
        isInvalid ? 'border-danger' : 'border-border-strong',
        mono && 'font-mono',
        className
      )}
      {...props}
    />
  );
});
