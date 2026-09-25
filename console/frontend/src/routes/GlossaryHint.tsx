import { CircleHelp } from 'lucide-react';

import { Tooltip } from '../ui/Tooltip';

export interface GlossaryHintProps {
  /** The plain-language explanation, already translated. */
  text: string;
  /** Accessible name for the trigger, e.g. "More about overlay address". */
  label: string;
  className?: string;
}

/**
 * A small "what does this mean" trigger beside a dense label.
 *
 * The tooltip only ever adds to a fact that is already on screen in words -
 * the label it sits beside - so a touch-screen or screen-reader operator who
 * cannot reach it loses nothing but the plain-language explanation. It is a
 * real button (not a span with a hover handler), so it opens on keyboard
 * focus as well as on hover.
 */
export function GlossaryHint({ text, label, className }: GlossaryHintProps) {
  return (
    <Tooltip content={text}>
      <button
        type="button"
        aria-label={label}
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted hover:text-content focus-visible:outline-focus ${className ?? ''}`}
      >
        <CircleHelp aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}
