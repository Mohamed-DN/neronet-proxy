import { ArrowDownRight, ArrowRight, ArrowUpRight, CircleOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { isNotMeasured } from './dataState';

export interface StatDelta {
  /** Signed change against the previous period. `null` means not measured. */
  value: number | null;
  /** Formatted for display; the caller owns the locale and the unit. */
  label: string;
  /** Whether a rise is good. Latency rising is not. */
  goodDirection?: 'up' | 'down';
}

export interface StatProps {
  label: string;
  /**
   * The measurement. `null` or `undefined` means the control plane has never
   * received one, and is rendered as "Not measured" - never as 0.
   */
  value: string | number | null | undefined;
  unit?: string;
  delta?: StatDelta;
  /** Explains what is counted, under the value. */
  hint?: string;
  className?: string;
}

function deltaTone(delta: StatDelta): 'success' | 'danger' | 'muted' {
  if (delta.value === null || delta.value === 0) return 'muted';
  const rising = delta.value > 0;
  const good = (delta.goodDirection ?? 'up') === 'up' ? rising : !rising;
  return good ? 'success' : 'danger';
}

/**
 * One number, its unit, and optionally how it moved.
 *
 * The console used to print a plausible constant where it had no measurement.
 * A Stat with no value says so in words, in the reader's language, and colours
 * it as information rather than as a healthy figure.
 */
export function Stat({ label, value, unit, delta, hint, className }: StatProps) {
  const { t } = useTranslation('ui');
  const missing = isNotMeasured(value);

  const Arrow =
    delta && delta.value !== null && delta.value !== 0 ? (delta.value > 0 ? ArrowUpRight : ArrowDownRight) : ArrowRight;
  const tone = delta ? deltaTone(delta) : 'muted';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-caption font-medium uppercase tracking-wide text-muted">{label}</span>

      {missing ? (
        <span
          data-state="not-measured"
          title={t('notMeasured.explain')}
          className="inline-flex items-center gap-1.5 text-title font-medium text-info"
        >
          <CircleOff aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('state.notMeasured')}
        </span>
      ) : (
        <span className="flex items-baseline gap-1.5">
          <span className="text-metric font-semibold tabular-nums text-content">{value}</span>
          {unit && <span className="text-body text-muted">{unit}</span>}
        </span>
      )}

      {delta && !missing && (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-caption tabular-nums',
            tone === 'success' && 'text-success',
            tone === 'danger' && 'text-danger',
            tone === 'muted' && 'text-subtle'
          )}
        >
          <Arrow aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {delta.value === null ? t('state.notMeasured') : delta.label}
        </span>
      )}

      {hint && <span className="text-caption text-subtle">{hint}</span>}
    </div>
  );
}
