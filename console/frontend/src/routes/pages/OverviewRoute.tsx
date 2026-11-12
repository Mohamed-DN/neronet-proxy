import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Globe2, Plus } from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { GlossaryHint } from '../GlossaryHint';
import { ROUTES, type RouteId } from '../paths';
import { useShell } from '../shell';
import { useStatsGeoMatrix, useStatsOverview, useStatsTimeseries } from '../../services/queries/stats';
import { LineChart } from '../../charts/LineChart';
import { NetworkSketch } from '../../charts/NetworkSketch';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { EmptyState, ErrorState, NotMeasured, Skeleton } from '../../ui/States';

const RANGES = ['1h', '6h', '24h', '7d'] as const;

/**
 * Formats byte count with binary prefixes (base 1024, so KiB and MiB).
 */
export function formatBytes(bytes: number | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[i]}`;
}

export interface OverviewRouteProps {
  onNavigateTab?: (tab: RouteId) => void;
}

function Figure({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-body text-muted">{label}</dt>
      <dd className="text-body font-medium tabular-nums text-content">{children}</dd>
    </div>
  );
}

export default function OverviewRoute({ onNavigateTab }: OverviewRouteProps) {
  const { t } = useTranslation('overview');
  const navigate = useNavigate();
  const shell = useShell();
  const [timeRange, setTimeRange] = useState<string>('24h');

  const overviewQuery = useStatsOverview();
  const timeseriesQuery = useStatsTimeseries(timeRange);
  const geoQuery = useStatsGeoMatrix();

  const stats = overviewQuery.data;
  const coverage = stats?.traffic;
  const timeseries = timeseriesQuery.data ?? [];
  const geoMatrix = geoQuery.data ?? [];

  const loadError = overviewQuery.error?.message || timeseriesQuery.error?.message || geoQuery.error?.message || null;
  const unreachable = overviewQuery.isError && !stats;

  // Counts come from the server; a value it did not send is shown as not measured, never as zero.
  const totalNodes = stats?.total_nodes ?? stats?.active_nodes ?? 0;
  const liveNodes = Math.min(stats?.active_nodes ?? 0, totalNodes);
  const downNodes = Math.max(0, totalNodes - liveNodes);
  const quarantinedNodes = stats?.quarantined_nodes ?? 0;
  const activeUsers = stats?.active_users ?? stats?.connected_users ?? 0;
  const verifiedCompliant = stats?.posture_verified_compliant_nodes ?? null;
  const unverifiedNodes = stats?.posture_unverified_nodes ?? null;
  const nonCompliantNodes = stats?.posture_non_compliant_nodes ?? null;
  const livenessSeconds = stats?.liveness_window_seconds ?? 60;

  const rxBandwidth = stats?.total_bandwidth_rx_mb_s ?? null;
  const txBandwidth = stats?.total_bandwidth_tx_mb_s ?? null;
  const haveRates = rxBandwidth !== null && txBandwidth !== null;
  const totalBandwidth = haveRates ? +(Number(rxBandwidth) + Number(txBandwidth)).toFixed(2) : null;

  const statusSentence = (() => {
    if (unreachable) return t('status.unknown');
    if (totalNodes === 0) return t('status.none');
    if (liveNodes === 0) return t('status.noneAnswering');
    if (downNodes === 0) return t('status.all', { count: totalNodes });
    return t('status.some', { count: downNodes, down: downNodes, total: totalNodes });
  })();
  const answeringPercent = totalNodes === 0 ? 0 : Math.round((liveNodes / totalNodes) * 100);

  const sites = geoMatrix.map((g) => ({ id: g.code, label: g.code, total: g.nodes, live: g.live }));

  const handleOpenMap = () => {
    if (onNavigateTab) {
      onNavigateTab('topology');
    } else {
      navigate(ROUTES.topology);
    }
  };

  const chartSeries = [
    {
      id: 'rx',
      label: t('inbound'),
      tone: 'chart-1' as const,
      values: timeseries.map((p) => (typeof p.rx === 'number' ? p.rx : null))
    },
    {
      id: 'tx',
      label: t('outbound'),
      tone: 'chart-2' as const,
      values: timeseries.map((p) => (typeof p.tx === 'number' ? p.tx : null))
    }
  ];

  // A lone sample above zero is not a trend: with fewer than two samples that
  // carried traffic the chart would draw one spike over a flat line.
  const sampledTraffic = chartSeries.some((s) => s.values.filter((v) => v !== null && v > 0).length >= 2);

  const primaryAction =
    !overviewQuery.isLoading && !unreachable && totalNodes === 0 ? (
      <Button variant="primary" icon={Plus} onClick={shell.openEnroll}>
        {t('addDevice')}
      </Button>
    ) : undefined;

  return (
    <PageFrame>
      <div className="space-y-8">
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <Button variant="secondary" icon={Globe2} onClick={handleOpenMap}>
              {t('openMap')}
            </Button>
          }
          primaryAction={primaryAction}
        />

        {loadError && !unreachable && (
          <div role="alert" className="flex flex-col gap-1 border-l-2 border-danger pl-3 text-body text-content">
            <p className="font-medium">{t('staleWarning')}</p>
            <p className="text-caption text-muted">{loadError}</p>
          </div>
        )}

        {overviewQuery.isLoading ? (
          <Skeleton lines={3} />
        ) : unreachable ? (
          <ErrorState title={t('unreachable')} detail={loadError} onRetry={() => void overviewQuery.refetch()} />
        ) : totalNodes === 0 ? (
          <EmptyState title={t('emptyFleet.title')} body={t('emptyFleet.body')} />
        ) : (
          <>
            <section>
              <p className="text-heading font-medium text-content">{statusSentence}</p>
              <div
                role="img"
                aria-label={statusSentence}
                data-testid="answering-bar"
                className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
              >
                <div className="h-full bg-content" style={{ width: `${answeringPercent}%` }} />
              </div>
            </section>

            <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
              <NetworkSketch
                title={t('sketch.title')}
                description={t('sketch.description', {
                  count: geoMatrix.length,
                  live: liveNodes,
                  total: totalNodes,
                  seconds: livenessSeconds
                })}
                centerLabel={t('sketch.center')}
                sites={sites}
                moreLabel={(hidden) => t('sketch.more', { count: hidden })}
                hollowLegend={`${t('sketch.hollow')} ${t('sketch.caption')}`}
              />

              <div>
                <dl className="divide-y divide-border-subtle border-y border-border-subtle">
                  <Figure label={t('answering')}>{t('answeringOf', { live: liveNodes, total: totalNodes })}</Figure>
                  <Figure label={t('blocked')}>{quarantinedNodes}</Figure>
                  <Figure label={t('usersConnected')}>{activeUsers}</Figure>
                  <Figure label={t('trafficNow')}>
                    {totalBandwidth === null ? (
                      <span className="flex flex-col items-end">
                        <NotMeasured />
                        <span className="text-caption font-normal text-subtle">{t('rateHint')}</span>
                      </span>
                    ) : (
                      `${totalBandwidth} ${t('trafficUnit')}`
                    )}
                  </Figure>
                </dl>

                <div className="mt-6 flex items-center gap-2 text-caption text-muted">
                  <span>{t('checks.title')}</span>
                  <GlossaryHint term="posture" />
                </div>
                <dl className="mt-2 divide-y divide-border-subtle border-y border-border-subtle">
                  <Figure label={t('checks.verified')}>{verifiedCompliant ?? <NotMeasured />}</Figure>
                  <Figure label={t('checks.unverified')}>{unverifiedNodes ?? <NotMeasured />}</Figure>
                  <Figure label={t('checks.nonCompliant')}>{nonCompliantNodes ?? <NotMeasured />}</Figure>
                </dl>
              </div>
            </div>

            <section aria-labelledby="overview-traffic-title" className="border-t border-border-subtle pt-6">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="overview-traffic-title" className="text-heading font-medium text-content">
                    {t('timeseriesTitle')}
                  </h2>
                  <p className="mt-1 max-w-[65ch] text-caption text-muted">{t('timeseriesDesc')}</p>
                </div>
                <div role="group" aria-label={t('timeseriesTitle')} className="flex items-center gap-1">
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setTimeRange(r)}
                      aria-pressed={timeRange === r}
                      className={`rounded-sm px-2.5 py-1 text-caption tabular-nums focus-visible:outline-focus ${
                        timeRange === r ? 'bg-surface-hover font-medium text-content' : 'text-muted hover:text-content'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div data-testid="native-traffic-coverage" className="mt-3 flex flex-col gap-0.5 text-caption text-muted">
                <span>{t('trafficSource')}</span>
                <span>{t(`traffic_${coverage?.status || 'unknown'}`)}</span>
                {coverage && (
                  <span>
                    {t('trafficCoverage', {
                      measured: coverage.measured_nodes,
                      total: coverage.total_nodes,
                      seconds: coverage.freshness_seconds
                    })}
                  </span>
                )}
              </div>

              <div className="mt-4">
                {timeseriesQuery.isLoading ? (
                  <Skeleton lines={5} />
                ) : timeseries.length === 0 ? (
                  <EmptyState title={t('noSamples')} body={t('noSamplesDesc')} />
                ) : !sampledTraffic ? (
                  <EmptyState title={t('noTraffic')} body={t('noTrafficDesc')} />
                ) : (
                  <LineChart
                    title={t('timeseriesTitle')}
                    labels={timeseries.map((p) => p.time)}
                    series={chartSeries}
                    unit={t('trafficUnit')}
                    height={208}
                  />
                )}
              </div>

              <p className="mt-4 flex flex-wrap items-baseline justify-between gap-2 text-caption text-muted">
                <span>{t('lifetimeTransfer')}</span>
                <strong
                  className="font-medium tabular-nums text-content"
                  title={stats?.total_bandwidth_bytes ?? undefined}
                >
                  {stats?.total_bandwidth_bytes === null || stats?.total_bandwidth_bytes === undefined ? (
                    <NotMeasured />
                  ) : (
                    formatBytes(stats.total_bandwidth_bytes)
                  )}
                </strong>
              </p>
            </section>
          </>
        )}
      </div>
    </PageFrame>
  );
}
