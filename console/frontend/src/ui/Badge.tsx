import { cn } from './cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Mono face for identifiers, versions, protocol names. */
  mono?: boolean;
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-muted border-border',
  accent: 'bg-accent-subtle text-accent border-accent/30',
  success: 'bg-success-subtle text-success border-success/30',
  warning: 'bg-warning-subtle text-warning border-warning/30',
  danger: 'bg-danger-subtle text-danger border-danger/30',
  info: 'bg-info-subtle text-info border-info/30'
};

/**
 * A label on a thing: a version, a protocol, a count. A badge is not a status -
 * use StatusBadge for that, which carries an icon and a word as well as colour.
 */
export function Badge({ tone = 'neutral', mono = false, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-control border px-1.5 py-0.5 text-micro font-medium',
        TONES[tone],
        mono && 'font-mono',
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
