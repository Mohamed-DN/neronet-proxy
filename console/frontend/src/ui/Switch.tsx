import { useId } from 'react';
import * as RadixSwitch from '@radix-ui/react-switch';

import { cn } from './cn';
import { useField } from './FormField';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Required when the switch is not inside a FormField. */
  label?: string;
  /** Rendered beside the switch and used as its accessible name. */
  description?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/**
 * A switch applies its change at once; a checkbox waits for a submit. Use this
 * one only where flipping it takes effect immediately.
 *
 * Radix gives it role="switch" with aria-checked, Space and Enter, which is the
 * part hand-rolled toggles get wrong - most ship a div with an onClick.
 */
export function Switch({ checked, onCheckedChange, label, description, disabled = false, className, id }: SwitchProps) {
  const field = useField();
  const generated = useId();
  const controlId = id ?? field?.controlId ?? generated;
  const descriptionId = description ? `${controlId}-description` : undefined;

  const control = (
    <RadixSwitch.Root
      id={controlId}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      // Radix renders a button, and a <label for> does not name a button: the
      // name has to be on the control itself whether or not there is a label
      // element beside it.
      aria-label={label}
      aria-describedby={[field?.describedBy, descriptionId].filter(Boolean).join(' ') || undefined}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-pill border transition-colors',
        'focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-surface-sunken',
        className
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block h-3.5 w-3.5 rounded-pill bg-surface-raised shadow-raised transition-transform',
          'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[3px]',
          'data-[state=checked]:bg-accent-contrast'
        )}
      />
    </RadixSwitch.Root>
  );

  if (!description) return control;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col">
        <label htmlFor={controlId} className="cursor-pointer text-body font-medium text-content">
          {label}
        </label>
        <span id={descriptionId} className="text-caption text-subtle">
          {description}
        </span>
      </div>
      {control}
    </div>
  );
}
