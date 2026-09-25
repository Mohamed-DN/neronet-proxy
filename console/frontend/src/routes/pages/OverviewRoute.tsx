import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  Globe2,
  Server,
  ShieldCheck,
  TrendingUp,
  Users
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts';

import { PageFrame } from '../PageFrame';
import { ROUTES, type RouteId } from '../paths';
import { useStatsGeoMatrix, useStatsOverview, useStatsTimeseries } from '../../services/queries/stats';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, Skeleton } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { StatusBadge } from '../../ui/StatusBadge';

/**
 * Formats byte count with binary prefixes, or an em-dash when unmeasured.
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

export default function OverviewRoute({ onNavigateTab }: OverviewRouteProps) {
  const { t } = useTranslation('ui');
  const navigate = useNavigate();
  const [timeRange, setTimeRange] = useState<string>('24h');

  const overviewQuery = useStatsOverview();
  const timeseriesQuery = useStatsTimeseries(timeRange);
  const geoQuery = useStatsGeoMatrix();

  const stats = overviewQuery.data;
  const timeseries = timeseriesQuery.data ?? [];
  const geoMatrix = geoQuery.data ?? [];

  const loadError = overviewQuery.error?.message || timeseriesQuery.error?.message || geoQuery.error?.message || null;

  const totalNodes = stats?.total_nodes ?? stats?.active_nodes ?? 0;
  const activeNodes = stats?.active_nodes ?? 0;
  const quarantinedNodes = stats?.quarantined_nodes ?? 0;
  const activeUsers = stats?.active_users ?? stats?.connected_users ?? 0;

  // Posture counts: with zero total nodes, posture is unmeasured, never 0 or fake.
  const verifiedCompliant = totalNodes === 0 ? null : (stats?.posture_verified_compliant_nodes ?? null);
  const unverifiedNodes = totalNodes === 0 ? null : (stats?.posture_unverified_nodes ?? null);
  const nonCompliantNodes = totalNodes === 0 ? null : (stats?.posture_non_compliant_nodes ?? null);

  // Bandwidth rate: needs two samples to derive rate, null otherwise.
  const rxBandwidth = stats?.total_bandwidth_rx_mb_s ?? null;
  const txBandwidth = stats?.total_bandwidth_tx_mb_s ?? null;
  const haveRates = rxBandwidth !== null && txBandwidth !== null;
  const totalBandwidth = haveRates ? +(Number(rxBandwidth) + Number(txBandwidth)).toFixed(2) : null;

  // Mesh Posture Score Truthfulness:
  // An empty fleet (0 nodes) has never had posture measured.
  // It MUST be null so it renders as "Not measured" / data-state="not-measured".
  const healthScore = totalNodes === 0 ? null : (stats?.network_health_score ?? null);

  const postureStatus =
    healthScore === null ? 'not-measured' : healthScore === 100 ? 'ok' : healthScore >= 80 ? 'warning' : 'critical';

  const postureLabel =
    healthScore === null
      ? t('state.notMeasured')
      : healthScore === 100
        ? t('overview.allReachable')
        : healthScore >= 80
          ? t('overview.degraded')
          : healthScore > 0
            ? t('overview.impaired')
            : t('overview.fleetOffline');

  const dash = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : v);

  const handleNavigateTopology = () => {
    if (onNavigateTab) {
      onNavigateTab('topology');
    } else {
      navigate(ROUTES.topology);
    }
  };

  const CustomTooltip = ({
    active,
    payload,
    label
  }: {
    active?: boolean;
    payload?: Array<{ value: number; payload: { latency?: number } }>;
    label?: string;
  }) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-control border border-border bg-surface-raised/95 p-3 font-mono text-micro shadow-elevated backdrop-blur-md">
          <div className="mb-1 flex items-center gap-1.5 text-muted">
            <Clock className="h-3 w-3 text-subtle" />
            <span>Time: {label}</span>
          </div>
          <div className="flex items-center justify-between gap-4 text-accent">
            <span>{t('overview.inbound')}:</span>
            <span className="font-semibold tabular-nums">{payload[0]?.value} MB/s</span>
          </div>
          <div className="flex items-center justify-between gap-4 text-info">
            <span>{t('overview.outbound')}:</span>
            <span className="font-semibold tabular-nums">{payload[1]?.value} MB/s</span>
          </div>
          {payload[0]?.payload?.latency !== undefined && payload[0]?.payload?.latency !== null && (
            <div className="mt-1 flex items-center justify-between gap-4 border-t border-border pt-1 text-success">
              <span>Avg Latency:</span>
              <span className="font-semibold tabular-nums">{payload[0].payload.latency} ms</span>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <PageFrame>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-title font-semibold text-content">{t('overview.title')}</h1>
              <StatusBadge
                status={loadError ? 'critical' : 'ok'}
                label={loadError ? t('overview.unreachable') : t('overview.live')}
              />
            </div>
            <p className="mt-1 text-caption text-subtle">{t('overview.description')}</p>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon={Globe2} onClick={handleNavigateTopology}>
              {t('overview.viewTopology')}
            </Button>
          </div>
        </div>

        {/* Stale Warning Alert */}
        {loadError && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-card border border-danger/30 bg-danger/10 p-3 text-caption text-content"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div>
              <p className="font-semibold text-danger">{t('overview.staleWarning')}</p>
              <p className="mt-0.5 text-micro text-muted">{loadError}</p>
            </div>
          </div>
        )}

        {/* 4 KPI Metric Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Card 1: Active Sovereign Nodes */}
          <Card className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-caption text-muted">
                <span>{t('overview.activeNodes')}</span>
                <Server className="h-4 w-4 text-accent" />
              </div>
              <div className="mt-2">
                {overviewQuery.isLoading ? (
                  <Skeleton lines={2} />
                ) : (
                  <Stat label="" value={activeNodes} unit={`/ ${totalNodes} ${t('overview.enrolled')}`} />
                )}
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-3 font-mono text-[11px] text-muted space-y-1">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  <span>
                    {dash(verifiedCompliant)} {t('overview.postureVerified')}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-subtle">
                  <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
                  <span>
                    {dash(unverifiedNodes)} {t('overview.unverified')}
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-warning">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                  <span>
                    {dash(nonCompliantNodes)} {t('overview.nonCompliant')}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-danger">
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                  <span>
                    {quarantinedNodes} {t('overview.quarantined')}
                  </span>
                </span>
              </div>
            </div>
          </Card>

          {/* Card 2: Users */}
          <Card className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-caption text-muted">
                <span>{t('overview.totalUsers')}</span>
                <Users className="h-4 w-4 text-info" />
              </div>
              <div className="mt-2">
                {overviewQuery.isLoading ? (
                  <Skeleton lines={2} />
                ) : (
                  <Stat label="" value={activeUsers} unit={t('overview.activeTenants')} />
                )}
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-3 text-[11px] text-subtle">
              {t('overview.sameAccessHint')}
            </div>
          </Card>

          {/* Card 3: Throughput */}
          <Card className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-caption text-muted">
                <span>{t('overview.throughput')}</span>
                <Activity className="h-4 w-4 text-success" />
              </div>
              <div className="mt-2">
                {overviewQuery.isLoading ? (
                  <Skeleton lines={2} />
                ) : haveRates ? (
                  <Stat label="" value={totalBandwidth} unit="MB/s" />
                ) : (
                  <Stat label="" value={null} hint={t('overview.rateHint')} />
                )}
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-3 font-mono text-[11px] text-muted">
              {haveRates ? (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-accent">
                    <ArrowDownLeft className="h-3 w-3" />
                    <span className="tabular-nums">RX: {rxBandwidth} MB/s</span>
                  </span>
                  <span className="flex items-center gap-1 text-info">
                    <ArrowUpRight className="h-3 w-3" />
                    <span className="tabular-nums">TX: {txBandwidth} MB/s</span>
                  </span>
                </div>
              ) : (
                <span className="text-subtle">{t('overview.rateHint')}</span>
              )}
            </div>
          </Card>

          {/* Card 4: Mesh Posture Score (Truthful rendering: null if totalNodes === 0) */}
          <Card className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-caption text-muted">
                <span>{t('overview.postureScore')}</span>
                <ShieldCheck className="h-4 w-4 text-success" />
              </div>
              <div className="mt-2">
                {overviewQuery.isLoading ? (
                  <Skeleton lines={2} />
                ) : (
                  <div className="flex items-baseline gap-2">
                    <Stat label="" value={healthScore} unit={healthScore === null ? undefined : '%'} />
                    <StatusBadge status={postureStatus} label={postureLabel} />
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-3 font-mono text-[11px] text-subtle tabular-nums">
              {totalNodes === 0 ? (
                <span>{t('overview.noNodesHint')}</span>
              ) : (
                <span>
                  {t('overview.reachableHint', {
                    active: activeNodes,
                    total: totalNodes,
                    seconds: stats?.liveness_window_seconds ?? 60
                  })}
                </span>
              )}
            </div>
          </Card>
        </div>

        {/* Charts & Geographic Presence Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Timeseries Throughput Chart (2 Cols) */}
          <Card className="lg:col-span-2">
            <CardHeader
              as="h2"
              title={
                <span className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-accent" />
                  <span>{t('overview.timeseriesTitle')}</span>
                </span>
              }
              description={t('overview.timeseriesDesc')}
              actions={
                <div className="flex items-center gap-1 rounded-control border border-border bg-surface p-0.5 text-caption font-mono">
                  {(['1h', '6h', '24h', '7d'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setTimeRange(r)}
                      aria-pressed={timeRange === r}
                      className={`rounded-sm px-2.5 py-1 text-micro transition-colors ${
                        timeRange === r ? 'bg-accent/20 font-semibold text-accent' : 'text-subtle hover:text-content'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              }
            />

            <div className="h-72 w-full pt-4">
              {timeseriesQuery.isLoading ? (
                <div className="flex h-full w-full items-center justify-center">
                  <Skeleton lines={6} className="w-full" />
                </div>
              ) : timeseries.length === 0 ? (
                <EmptyState title={t('overview.noSamples')} body={t('overview.noSamplesDesc')} className="h-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeseries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRx" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                      </linearGradient>
                      <linearGradient id="colorTx" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                    <XAxis
                      dataKey="time"
                      stroke="var(--color-muted)"
                      tick={{ fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'monospace' }}
                    />
                    <YAxis
                      stroke="var(--color-muted)"
                      tick={{ fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'monospace' }}
                      unit=" MB/s"
                    />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="rx"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#colorRx)"
                      name={t('overview.inbound')}
                    />
                    <Area
                      type="monotone"
                      dataKey="tx"
                      stroke="#6366f1"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#colorTx)"
                      name={t('overview.outbound')}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between border-t border-border pt-3 font-mono text-micro text-muted">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5 text-accent">
                  <span className="h-2 w-2 rounded-full bg-accent" />
                  <span>{t('overview.inbound')}</span>
                </span>
                <span className="flex items-center gap-1.5 text-info">
                  <span className="h-2 w-2 rounded-full bg-info" />
                  <span>{t('overview.outbound')}</span>
                </span>
              </div>
              <span>
                {t('overview.lifetimeTransfer')}{' '}
                <strong className="text-content tabular-nums">{formatBytes(stats?.total_bandwidth_bytes)}</strong>
              </span>
            </div>
          </Card>

          {/* Geographic Distribution Matrix (1 Col) */}
          <Card className="flex flex-col justify-between">
            <div>
              <CardHeader
                as="h2"
                title={
                  <span className="flex items-center gap-2">
                    <Globe2 className="h-4 w-4 text-info" />
                    <span>{t('overview.geoTitle')}</span>
                  </span>
                }
                description={t('overview.geoDesc')}
                actions={
                  <span className="font-mono text-micro text-subtle tabular-nums">
                    {t('overview.countriesCount', { count: geoMatrix.length })}
                  </span>
                }
              />

              <div className="mt-2 max-h-72 space-y-2.5 overflow-y-auto pr-1">
                {geoQuery.isLoading ? (
                  <Skeleton lines={4} />
                ) : geoMatrix.length === 0 ? (
                  <EmptyState title={t('overview.noNodesGeo')} body={t('overview.noNodesGeoDesc')} className="p-4" />
                ) : (
                  geoMatrix.map((g) => (
                    <div
                      key={g.code}
                      className="flex items-center justify-between rounded-control border border-border bg-surface p-2.5 font-mono text-micro transition-colors hover:border-border-strong"
                    >
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-1.5 font-semibold text-content">
                          <span className="truncate">{g.country}</span>
                          <span className="text-[10px] font-normal text-subtle">{g.code}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted tabular-nums">
                          {g.live}/{g.nodes} {t('overview.up')}
                          {g.relays > 0 && (
                            <>
                              {' '}
                              • {g.relays} {t('overview.relay')}
                            </>
                          )}
                          {g.exits > 0 && (
                            <>
                              {' '}
                              • {g.exits} {t('overview.exit')}
                            </>
                          )}
                        </div>
                      </div>

                      <div className="ml-3 shrink-0 text-right">
                        <div className="font-semibold text-accent tabular-nums">
                          {g.avg_latency === null || g.avg_latency === undefined ? (
                            <span className="font-normal text-subtle text-[10px]">{t('overview.noRtt')}</span>
                          ) : (
                            `${g.avg_latency}ms`
                          )}
                        </div>
                        <StatusBadge
                          compact
                          status={g.status === 'Online' ? 'ok' : g.status === 'Degraded' ? 'warning' : 'critical'}
                          label={g.status}
                          className="mt-1"
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </PageFrame>
  );
}
