import { forwardRef, useId } from 'react';

import { cn } from './cn';
import { useField } from './FormField';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Shown beside the box. Omit only when the box is inside a FormField. */
  label?: string;
  /** Neither checked nor unchecked: some of the rows below are selected. */
  indeterminate?: boolean;
}

/**
 * A native checkbox. Radix adds nothing here: the browser's own control already
 * has the right role, the right keyboard behaviour and the right announcement,
 * and the only thing to fix is how it looks.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate = false, className, id, ...props },
  ref
) {
  const field = useField();
  const generated = useId();
  // A label needs something to point at. Without a FormField and without an id
  // from the caller the box would render with an unlabelled htmlFor, which is
  // worse than no label at all.
  const controlId = id ?? field?.controlId ?? generated;
  const setRef = (node: HTMLInputElement | null) => {
    if (node) node.indeterminate = indeterminate;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };

  const input = (
    <input
      ref={setRef}
      type="checkbox"
      id={controlId}
      aria-describedby={field?.describedBy}
      aria-checked={indeterminate ? 'mixed' : undefined}
      className={cn(
        'h-4 w-4 shrink-0 cursor-pointer rounded-sm border border-border-strong bg-surface-raised',
        'accent-accent focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );

  if (!label) return input;

  return (
    <div className="flex items-center gap-2">
      {input}
      <label htmlFor={controlId} className="cursor-pointer text-body text-content">
        {label}
      </label>
    </div>
  );
});
