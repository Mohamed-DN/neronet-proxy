import { AlertTriangle, CircleHelp, CircleOff, CheckCircle2, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';

/**
 * `unknown` and `not-measured` are different facts and must not be merged.
 *
 *   unknown       a value arrived and the console cannot classify it
 *   not-measured  no value has ever arrived
 *
 * A node whose posture was never reported is not a node with unknown posture:
 * the first is a gap in the product, the second is a finding about the node.
 */
export type Status = 'ok' | 'warning' | 'critical' | 'unknown' | 'not-measured';

export interface StatusBadgeProps {
  status: Status;
  /** Overrides the standard word. The word is never dropped. */
  label?: string;
  /** Hides the word, leaving icon plus colour with the word as a tooltip. */
  compact?: boolean;
  className?: string;
}

const ICONS: Record<Status, LucideIcon> = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  critical: XCircle,
  unknown: CircleHelp,
  'not-measured': CircleOff
};

const TONES: Record<Status, string> = {
  ok: 'bg-success-subtle text-success border-success/30',
  warning: 'bg-warning-subtle text-warning border-warning/30',
  critical: 'bg-danger-subtle text-danger border-danger/30',
  unknown: 'bg-surface-sunken text-muted border-border',
  'not-measured': 'bg-info-subtle text-info border-info/30'
};

const LABEL_KEYS: Record<Status, string> = {
  ok: 'status.ok',
  warning: 'status.warning',
  critical: 'status.critical',
  unknown: 'status.unknown',
  'not-measured': 'status.notMeasured'
};

/**
 * Status is a colour, an icon and a word together, never colour alone: an
 * operator who cannot separate the green from the red still reads the state,
 * and so does a screen reader.
 */
export function StatusBadge({ status, label, compact = false, className }: StatusBadgeProps) {
  const { t } = useTranslation('ui');
  const Icon = ICONS[status];
  const text = label ?? t(LABEL_KEYS[status]);

  return (
    <span
      data-status={status}
      title={compact ? text : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-control border px-1.5 py-0.5 text-micro font-medium',
        TONES[status],
        className
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className={cn(compact && 'sr-only')}>{text}</span>
    </span>
  );
}
