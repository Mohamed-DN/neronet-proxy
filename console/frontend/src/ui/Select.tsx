import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from './cn';
import { useField } from './FormField';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Required when the Select is not inside a FormField. */
  label?: string;
  'aria-label'?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  /** Test hook; Radix renders the trigger as a button. */
  name?: string;
}

/**
 * Built on Radix Select rather than a styled <select>, because the listbox has
 * to match the rest of the console and because typeahead, Home/End, Escape and
 * the aria-activedescendant bookkeeping are exactly the things a hand-rolled
 * menu gets wrong.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  label,
  'aria-label': ariaLabel,
  disabled = false,
  invalid,
  className,
  name
}: SelectProps) {
  const field = useField();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled} name={name}>
      <RadixSelect.Trigger
        id={field?.controlId}
        aria-label={label ?? ariaLabel}
        aria-describedby={field?.describedBy}
        aria-invalid={isInvalid || undefined}
        className={cn(
          'inline-flex h-9 w-full items-center justify-between gap-2 rounded-control border bg-surface-raised px-3',
          'text-body text-content focus-visible:outline-focus',
          'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-subtle',
          'data-[placeholder]:text-subtle',
          isInvalid ? 'border-danger' : 'border-border-strong',
          className
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-popover max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
            'rounded-card border border-border bg-surface-raised shadow-popover'
          )}
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-7 pr-3',
                  'text-body text-content outline-none',
                  'data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50'
                )}
              >
                <RadixSelect.ItemIndicator className="absolute left-2">
                  <Check aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
