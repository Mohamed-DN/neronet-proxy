import { cn } from './cn';
import { STATION_TONE, StationSymbol, type StationKind } from './StationSymbol';

export interface StationRowListProps {
  /** Names the list for a screen reader, e.g. "Devices". */
  label: string;
  children: React.ReactNode;
  className?: string;
}

/** The rows a table turns into below 1280 px: a plate of station rows. */
export function StationRowList({ label, children, className }: StationRowListProps) {
  return (
    // eslint-disable-next-line jsx-a11y/no-redundant-roles
    <ul
      role="list"
      aria-label={label}
      className={cn(
        'divide-y divide-border-subtle overflow-hidden rounded-card border border-border bg-plate',
        className
      )}
    >
      {children}
    </ul>
  );
}

export interface StationRowProps {
  /** The station symbol; the status word belongs in `meta`, never the symbol alone. */
  kind: StationKind;
  title: React.ReactNode;
  /** One muted line under the name. */
  meta?: React.ReactNode;
  /** Sits at the end of the row: a count, a short badge. */
  trailing?: React.ReactNode;
  /** The row whose detail is open next to the list (tablet). */
  selected?: boolean;
  onSelect: () => void;
  className?: string;
}

/**
 * One row of a list on a tablet or a phone: station symbol, name, one muted
 * line. The whole row is the button and at least 56 px tall, so it is a touch
 * target; "open" has no separate control to find.
 */
export function StationRow({ kind, title, meta, trailing, selected = false, onSelect, className }: StationRowProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'focus-ring flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start transition-colors',
          selected ? 'bg-accent-subtle shadow-[inset_4px_0_0_rgb(var(--color-ink))]' : 'hover:bg-surface-hover',
          className
        )}
      >
        <StationSymbol kind={kind} size={20} className={cn('shrink-0', STATION_TONE[kind])} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('truncate text-body text-ink', selected ? 'font-semibold' : 'font-medium')}>{title}</span>
          {meta && <span className="truncate text-caption text-ink-muted">{meta}</span>}
        </span>
        {trailing && <span className="shrink-0 text-caption text-ink-muted">{trailing}</span>}
      </button>
    </li>
  );
}
