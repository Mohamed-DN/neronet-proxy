import { useRef } from 'react';

import { cn } from './cn';

export interface SegmentedOption<V extends string> {
  value: V;
  label: React.ReactNode;
}

export interface SegmentedProps<V extends string> {
  options: Array<SegmentedOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /** Names the group for a screen reader. Required. */
  label: string;
  className?: string;
}

/**
 * One choice out of a few, shown side by side: a radio group, so it is a single
 * stop in the tab order and the arrow keys move the choice (Home and End go to
 * the ends), as the WAI-ARIA radio pattern says. The choice follows focus, which
 * suits a filter that applies at once. Not a row of toggle buttons.
 */
export function Segmented<V extends string>({ options, value, onChange, label, className }: SegmentedProps<V>) {
  const group = useRef<HTMLDivElement>(null);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );

  const move = (event: React.KeyboardEvent, from: number) => {
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = from === last ? 0 : from + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = from === 0 ? last : from - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    onChange(options[next]!.value);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex flex-wrap items-center rounded-control border border-rule bg-plate p-0.5', className)}
    >
      {options.map((option, index) => {
        const active = index === selected;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'h-8 whitespace-nowrap rounded-control px-3 text-caption focus-visible:outline-focus',
              active ? 'bg-ink font-semibold text-sheet' : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
