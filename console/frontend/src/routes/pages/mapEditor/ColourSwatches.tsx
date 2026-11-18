import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { pulseTone } from '../../../charts/pulseTone';
import { cn } from '../../../ui/cn';
import type { LineColour } from '../../../services/types';
import { LINE_COLOURS } from '../transitModel';

/** Static class names, so Tailwind sees every one of them. */
const FILL: Record<LineColour, string> = {
  red: 'bg-line-red',
  green: 'bg-line-green',
  blue: 'bg-line-blue',
  orange: 'bg-line-orange',
  violet: 'bg-line-violet',
  sky: 'bg-line-sky'
};

export interface ColourSwatchesProps {
  /** The chosen colour, or null for "Automatico" (the console picks). */
  value: LineColour | null;
  onChange: (value: LineColour | null) => void;
  /** Names the group for a screen reader. */
  label: string;
  /** Offer "Automatico" as a seventh choice. */
  allowAutomatic?: boolean;
  /** The automatic colour, drawn in its swatch so the choice is not blind. */
  automaticColour?: LineColour;
  disabled?: boolean;
  /**
   * The arrow keys choose as they move (the usual radio group). Turn it off where choosing
   * saves at once: the arrows then only move focus, and Space or Enter chooses.
   */
  selectOnArrow?: boolean;
}

/**
 * The six line colours as swatches with their names. Never a free colour: the tokens are the
 * only colours that hold 3:1 on the map in both themes. It is a radio group: one tab stop,
 * the arrow keys move and choose, and the chosen one carries a check as well as a ring, so
 * the choice never rests on colour alone.
 */
export function ColourSwatches({
  value,
  onChange,
  label,
  allowAutomatic = false,
  automaticColour,
  disabled = false,
  selectOnArrow = true
}: ColourSwatchesProps) {
  const { t } = useTranslation('mapEditor');
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const options: Array<LineColour | null> = allowAutomatic ? [null, ...LINE_COLOURS] : [...LINE_COLOURS];
  const selectedIndex = Math.max(0, options.indexOf(value));
  const [focused, setFocused] = useState<number | null>(null);
  const tabStop = focused ?? selectedIndex;

  const move = (from: number, step: number) => {
    const next = (from + step + options.length) % options.length;
    if (selectOnArrow) onChange(options[next] ?? null);
    setFocused(next);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((colour, index) => {
        const chosen = colour === value;
        const name = colour === null ? t('line.automatic') : t(`colourName.${colour}`);
        const shown = colour ?? automaticColour;
        return (
          <button
            key={colour ?? 'auto'}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={chosen}
            data-colour={colour ?? 'auto'}
            tabIndex={index === tabStop ? 0 : -1}
            onFocus={() => setFocused(index)}
            disabled={disabled}
            onClick={() => onChange(colour)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={cn(
              'flex min-h-9 items-center gap-2 rounded-control border bg-surface-raised px-2.5 text-body text-ink focus-visible:outline-focus',
              chosen ? 'border-ink' : 'border-border-strong hover:bg-surface-hover',
              disabled && 'cursor-not-allowed opacity-60'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-pill',
                shown ? FILL[shown] : 'border border-border-strong',
                colour === null && 'opacity-60'
              )}
            >
              {chosen && (
                <Check
                  size={14}
                  strokeWidth={3}
                  className={
                    !shown
                      ? 'text-ink'
                      : pulseTone(shown) === 'light'
                        ? 'text-[rgb(var(--color-pulse-light))]'
                        : 'text-[rgb(var(--color-pulse-dark))]'
                  }
                />
              )}
            </span>
            {name}
          </button>
        );
      })}
    </div>
  );
}
