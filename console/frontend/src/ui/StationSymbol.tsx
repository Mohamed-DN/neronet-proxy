import { cn } from './cn';

/**
 * Station symbols, drawn the way a transit map draws a stop. They are the only
 * way a status or a kind of place is drawn in the console, and each one differs
 * in shape as well as colour, so none depends on colour alone:
 *
 *   service      a filled ring        in service
 *   unmeasured   a hollow ring        no measurement has ever arrived
 *   blocked      a ring with a bar    blocked
 *   interrupted  a dashed ring        was seen, is not answering
 *   interchange  a rounded square, double ring     a gateway
 *   terminus     a ring with an outward tick       an exit to the internet
 *
 * The stroke is `currentColor`, so a symbol takes the colour of its context
 * (a status colour token, a line colour, or ink). It is decorative by default
 * and always sits beside a visible word; where space allows no word, pass
 * `label` and it becomes an image with that name.
 */
export type StationKind = 'service' | 'unmeasured' | 'blocked' | 'interrupted' | 'interchange' | 'terminus';

export const STATION_KINDS: readonly StationKind[] = [
  'service',
  'unmeasured',
  'blocked',
  'interrupted',
  'interchange',
  'terminus'
];

export interface StationSymbolProps {
  kind: StationKind;
  /** Pixel size of the square the symbol is drawn in. */
  size?: number;
  /** Names the symbol when no word sits beside it. Without it the symbol is hidden from assistive technology. */
  label?: string;
  className?: string;
}

export function StationSymbol({ kind, size = 16, label, className }: StationSymbolProps) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 } as const;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      data-station={kind}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={cn('shrink-0', className)}
    >
      {kind === 'service' && (
        <>
          <circle cx="8" cy="8" r="6.25" {...stroke} />
          <circle cx="8" cy="8" r="3.5" fill="currentColor" />
        </>
      )}
      {kind === 'unmeasured' && <circle cx="8" cy="8" r="6.25" {...stroke} />}
      {kind === 'blocked' && (
        <>
          <circle cx="8" cy="8" r="6.25" {...stroke} />
          <path d="M3.75 8h8.5" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        </>
      )}
      {kind === 'interrupted' && <circle cx="8" cy="8" r="6.25" {...stroke} strokeDasharray="3.2 2.4" />}
      {kind === 'interchange' && (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="4" {...stroke} />
          <rect x="5" y="5" width="6" height="6" rx="2" {...stroke} strokeWidth={1.5} />
        </>
      )}
      {kind === 'terminus' && (
        <>
          <circle cx="6.5" cy="8" r="4.75" {...stroke} />
          <path d="M11.25 8h3.5" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** The status colour token each symbol is drawn in; the word beside it stays ink. */
export const STATION_TONE: Record<StationKind, string> = {
  service: 'text-success',
  unmeasured: 'text-info',
  blocked: 'text-danger',
  interrupted: 'text-warning',
  interchange: 'text-ink',
  terminus: 'text-ink'
};

export interface StationStatusProps {
  kind: StationKind;
  /** The word. It is required: a status is never the symbol alone. */
  children: React.ReactNode;
  className?: string;
}

/** A status: the station symbol in its status colour, then the word in ink. */
export function StationStatus({ kind, children, className }: StationStatusProps) {
  return (
    <span data-status={kind} className={cn('inline-flex items-center gap-1.5 text-body text-ink', className)}>
      <StationSymbol kind={kind} className={STATION_TONE[kind]} />
      <span>{children}</span>
    </span>
  );
}
