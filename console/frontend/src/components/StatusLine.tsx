import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ArrowDownLeft, ArrowUpRight, Skull } from 'lucide-react';

import { ROUTES } from '../routes/paths';
import { useStatsOverview } from '../services/queries';
import { NotMeasured, StationSymbol, cn } from '../ui';

function useCountdown(armed: boolean, scheduledAt: string | null): string {
  const { t } = useTranslation('chrome');
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    if (!armed && !scheduledAt) return;

    const update = () => {
      if (scheduledAt) {
        const diff = new Date(scheduledAt).getTime() - Date.now();
        if (diff <= 0) {
          setRemaining(t('status.triggered'));
        } else {
          const hours = Math.floor(diff / (1000 * 60 * 60));
          const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          const secs = Math.floor((diff % (1000 * 60)) / 1000);
          setRemaining(
            `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
          );
        }
      } else if (armed) {
        setRemaining(t('status.erasureArmedInstant'));
      }
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [armed, scheduledAt, t]);

  return remaining;
}

export interface StatusLineProps {
  nodeCount: number;
  reachableCount: number;
  quarantinedCount: number;
  highRiskCount: number;
  /** Whether this role may open the risk page; the link is left out when it may not. */
  canSeeRisk: boolean;
  nukeArmed: boolean;
  nukeScheduledAt: string | null;
  onExecuteWipe?: () => void;
  /**
   * One sentence for a phone: how many devices are in service, and a link only
   * when something needs attention. The throughput readings and the "none
   * blocked" filler are left out.
   */
  condensed?: boolean;
}

function Throughput() {
  const { t } = useTranslation('chrome');
  // The rate is null until the collector has two samples to derive it from, and
  // the line says "not measured" then rather than a zero.
  const overview = useStatsOverview();
  const stats = overview.status === 'success' ? overview.data : null;
  const rate = (value: number | null | undefined) =>
    typeof value === 'number' ? <span className="font-medium tabular-nums">{value} MiB/s</span> : <NotMeasured />;

  return (
    <span aria-label={t('header.throughput')} className="ml-auto hidden items-center gap-4 text-content lg:flex">
      <span className="flex items-center gap-1.5">
        <ArrowDownLeft aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
        <span className="text-muted">{t('header.rx')}:</span>
        {rate(stats?.total_bandwidth_rx_mb_s)}
      </span>
      <span className="flex items-center gap-1.5">
        <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
        <span className="text-muted">{t('header.tx')}:</span>
        {rate(stats?.total_bandwidth_tx_mb_s)}
      </span>
    </span>
  );
}

/**
 * The line under the bars that says in words how the network is doing: the same
 * statuses the map draws as stations. The armed-erasure reminder lives here so it
 * is on every page at every size.
 */
export function StatusLine({
  nodeCount,
  reachableCount,
  quarantinedCount,
  highRiskCount,
  canSeeRisk,
  nukeArmed,
  nukeScheduledAt,
  onExecuteWipe,
  condensed = false
}: StatusLineProps) {
  const { t } = useTranslation('chrome');
  const remaining = useCountdown(nukeArmed, nukeScheduledAt);
  const armed = nukeArmed || Boolean(nukeScheduledAt);

  return (
    <div role="group" aria-label={t('status.label')} className="border-t border-border-subtle bg-sheet">
      <div
        className={cn(
          'mx-auto flex w-full max-w-[1360px] flex-wrap items-center gap-x-5 gap-y-1 py-1 text-caption text-muted',
          condensed ? 'min-h-8 px-4' : 'min-h-9 px-6'
        )}
      >
        {armed && (
          <span className="flex items-center gap-2 rounded-control border border-danger bg-danger/10 py-0.5 pl-2 pr-0.5 text-danger">
            <Skull aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="font-semibold">{t('status.erasureArmed')}</span>
            <span className="tabular-nums">{remaining}</span>
            <button
              type="button"
              onClick={onExecuteWipe}
              className="rounded-control bg-danger px-2 py-0.5 font-semibold text-danger-contrast transition-colors hover:bg-danger-strong focus-visible:outline-focus max-xl:min-h-11"
            >
              {t('status.eraseNow')}
            </button>
          </span>
        )}

        <span className="flex items-center gap-1.5 text-content">
          <StationSymbol kind="service" size={14} className="text-success" />
          {nodeCount === 0
            ? t('status.noDevices')
            : t('status.inService', { reachable: reachableCount, total: nodeCount })}
        </span>

        {quarantinedCount > 0 ? (
          <Link
            to={ROUTES.nodes}
            className="flex items-center gap-1.5 rounded-control font-medium text-danger underline focus-visible:outline-focus max-xl:-my-3.5 max-xl:py-3.5"
          >
            <StationSymbol kind="blocked" size={14} />
            {t('status.blocked', { count: quarantinedCount })}
          </Link>
        ) : (
          !condensed && <span>{t('status.noneBlocked')}</span>
        )}

        {highRiskCount > 0 && canSeeRisk && !(condensed && quarantinedCount > 0) && (
          <Link
            to={ROUTES.risk}
            className="rounded-control font-medium text-warning underline focus-visible:outline-focus max-xl:-my-3.5 max-xl:py-3.5"
          >
            {t('status.highRisk', { count: highRiskCount })}
          </Link>
        )}

        {!condensed && <Throughput />}
      </div>
    </div>
  );
}
