import { createContext, useContext, useId } from 'react';
import { AlertCircle } from 'lucide-react';

import { cn } from './cn';

interface FieldContextValue {
  /** id the control must carry, so the label points at it. */
  controlId: string;
  /** ids of the hint and the error, for the control's aria-describedby. */
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Read by Input, Select, Checkbox and Switch so that a control inside a
 * FormField wires itself to the label, the hint and the error without the
 * caller repeating the ids.
 */
export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FormFieldProps {
  label: string;
  /** Explains the format or the consequence, before the operator types. */
  hint?: string;
  /** Present means the field is invalid; the text is announced. */
  error?: string | null;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Label, hint and error around one control, wired with aria-describedby.
 *
 * The error is a live region: it is announced when it appears after a failed
 * submission, without moving focus away from what the operator was doing.
 */
export function FormField({ label, hint, error, required = false, className, children }: FormFieldProps) {
  const base = useId();
  const controlId = `${base}-control`;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <FieldContext.Provider value={{ controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        <label htmlFor={controlId} className="text-label font-medium text-content">
          {label}
          {required && (
            <span aria-hidden="true" className="ml-1 text-danger">
              *
            </span>
          )}
        </label>
        {hint && (
          <p id={hintId} className="text-caption text-subtle">
            {hint}
          </p>
        )}
        {children}
        <p
          id={errorId}
          role="alert"
          className={cn('flex items-center gap-1.5 text-caption text-danger', !error && 'hidden')}
        >
          {error && (
            <>
              <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </>
          )}
        </p>
      </div>
    </FieldContext.Provider>
  );
}
