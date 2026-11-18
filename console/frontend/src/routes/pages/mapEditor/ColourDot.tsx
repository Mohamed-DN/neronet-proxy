import { cn } from '../../../ui/cn';
import type { LineColour } from '../../../services/types';

const FILL: Record<LineColour, string> = {
  red: 'bg-line-red',
  green: 'bg-line-green',
  blue: 'bg-line-blue',
  orange: 'bg-line-orange',
  violet: 'bg-line-violet',
  sky: 'bg-line-sky'
};

/** A line's colour as a small bar, next to its name. Decorative: the name always says which line. */
export function ColourDot({ colour, className }: { colour: LineColour; className?: string }) {
  return <span aria-hidden="true" className={cn('h-1.5 w-6 shrink-0 rounded-pill', FILL[colour], className)} />;
}
