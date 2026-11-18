import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Plus } from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { ROUTES, nodePath, type RouteId } from '../paths';
import { useShell } from '../shell';
import { useStatsOverview, useStatsTimeseries } from '../../services/queries/stats';
import { isDefaultCompartment, useCompartmentLabel } from '../../services/compartmentLabel';
import { useNodes, useTopology } from '../../services/queries';
import { flowForLines, lineRates, sampleCounters, type CounterSample, type FlowParams } from '../../charts/liveFlow';
import { prefersReducedMotion } from '../../ui/motion';
import { LineChart } from '../../charts/LineChart';
import { TransitMap, mapTone, type MapHub, type MapLine, type MapStation } from '../../charts/TransitMap';
import { Button } from '../../ui/Button';
import { PageHeader } from '../../ui/PageHeader';
import { StationStatus, StationSymbol } from '../../ui/StationSymbol';
import { EmptyState, ErrorState, NotMeasured, Skeleton } from '../../ui/States';
import {
  COLLAPSE_ABOVE,
  buildTransit,
  worstStatus,
  type StationStatusKind,
  type Tally,
  type TransitStationModel
} from './transitModel';

const RANGES = ['1h', '6h', '24h', '7d'] as const;
const STATUS_ORDER = ['service', 'interrupted', 'unmeasured', 'blocked'] as const;

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

export default function OverviewRoute({ onNavigateTab }: OverviewRouteProps) {
  const { t } = useTranslation('overview');
  const navigate = useNavigate();
  const shell = useShell();
  const labelOf = useCompartmentLabel();
  const [timeRange, setTimeRange] = useState<string>('24h');

  // The map is drawn from the same inventory the map page uses; the traffic
  // below it from the statistics endpoints.
  const topologyQuery = useTopology();
  const overviewQuery = useStatsOverview();
  const timeseriesQuery = useStatsTimeseries(timeRange);

  const stats = overviewQuery.data;
  const coverage = stats?.traffic;
  const timeseries = timeseriesQuery.data ?? [];

  const loadError = overviewQuery.error?.message || timeseriesQuery.error?.message || null;

  const nodes = topologyQuery.data?.nodes;
  // "Now" is when the inventory arrived, so a device's state does not tick between refreshes.
  const now = topologyQuery.dataUpdatedAt || 0;
  const links = topologyQuery.data?.links;
  const noSubnetLabel = t('map.noSubnet');
  // Above the collapse threshold each line is one stop, so nothing is shared.
  const shareHubs = (nodes?.length ?? 0) <= COLLAPSE_ABOVE;
  const model = useMemo(
    () =>
      buildTransit(
        (nodes ?? []).map((node) =>
          isDefaultCompartment({ name: node.compartment_name })
            ? { ...node, compartment_name: labelOf({ name: node.compartment_name }) }
            : node
        ),
        now,
        { noSubnetLabel, shareHubs, links }
      ),
    [nodes, now, labelOf, noSubnetLabel, shareHubs, links]
  );

  // Live flow: only from the byte counters the device list already carries, between two refreshes.
  const nodesQuery = useNodes();
  const lastSample = useRef<CounterSample | null>(null);
  const flowState = useRef<{ at: number; flow: ReadonlyMap<string, FlowParams> }>({ at: -1, flow: new Map() });
  const countersAt = nodesQuery.dataUpdatedAt;
  const nodeList = nodesQuery.data;
  if (nodeList && countersAt !== flowState.current.at) {
    const current = sampleCounters(nodeList, countersAt);
    const lineOf = new Map<string, string>();
    for (const line of model.lines) for (const station of line.stations) lineOf.set(station.id, line.key);
    flowState.current = {
      at: countersAt,
      flow: flowForLines(lineRates(lastSample.current, current, lineOf))
    };
    lastSample.current = current;
  }
  const flow = flowState.current.flow;
  const flowing = flow.size > 0 && !prefersReducedMotion();

  const total = model.tally.total;
  const collapsed = total > COLLAPSE_ABOVE;

  const statusWord = (status: StationStatusKind) => t(`state.${status}`);
  const part = (count: number, key: 'service' | 'interrupted' | 'blocked' | 'unmeasured') =>
    count === 0 ? t(`sentence.${key}None`) : t(`sentence.${key}`, { count });

  /** "12 devices in service, one interrupted, none blocked." The words of the symbols, in one sentence. */
  const sentence = (tally: Tally) => {
    if (tally.total === 0) return t('sentence.noDevices');
    const parts = [
      part(tally.service, 'service'),
      part(tally.interrupted, 'interrupted'),
      part(tally.blocked, 'blocked')
    ];
    if (tally.unmeasured > 0) parts.push(part(tally.unmeasured, 'unmeasured'));
    const text = parts.join(', ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  };

  const openStation = (id: string) => {
    if (id.startsWith('line:')) navigate(ROUTES.nodes);
    else navigate(nodePath(id));
  };

  const describe = (station: { name: string; role: TransitStationModel['role']; status: StationStatusKind }) => {
    const status = statusWord(station.status);
    return station.role === 'gateway'
      ? t('map.stationGateway', { name: station.name, status })
      : station.role === 'exit'
        ? t('map.stationExit', { name: station.name, status })
        : t('map.station', { name: station.name, status });
  };

  const { mapLines, mapHubs } = useMemo(() => {
    const hubs: MapHub[] = model.hubs.map((hub) => ({
      id: hub.id,
      label: hub.name,
      symbol: hub.symbol,
      tone: mapTone(hub.symbol),
      description: describe(hub),
      kind: hub.kind,
      lineKeys: hub.lineKeys
    }));
    const inHub = new Set(hubs.flatMap((hub) => hub.lineKeys));
    const lines: MapLine[] = model.lines.flatMap((line): MapLine[] => {
      const count = t('map.deviceCount', { count: line.stations.length });
      if (collapsed) {
        const status = worstStatus(line.tally);
        const kind = status;
        const words = `${count}, ${statusWord(status)}`;
        const station: MapStation = {
          id: `line:${line.key}`,
          label: count,
          symbol: kind,
          tone: mapTone(kind),
          description: `${line.label}, ${words}`
        };
        return [{ key: line.key, heading: line.label, colour: line.colour, stations: [station] }];
      }
      // A gateway that serves this line alone comes first, an exit that ends it last; shared ones are drawn apart.
      const rank = (role: TransitStationModel['role']) => (role === 'gateway' ? 0 : role === 'exit' ? 2 : 1);
      const drawn = line.stations.filter((station) => !station.shared);
      const ordered = drawn.map((station, index) => ({ station, index }));
      ordered.sort((a, b) => rank(a.station.role) - rank(b.station.role) || a.index - b.index);
      if (ordered.length === 0 && !inHub.has(line.key)) return [];
      const stations = ordered.map(
        ({ station }): MapStation => ({
          id: station.id,
          label: station.name,
          symbol: station.symbol,
          tone: mapTone(station.symbol),
          description: describe(station)
        })
      );
      const last = ordered.at(-1)?.station;
      return [
        {
          key: line.key,
          heading: line.label,
          detail: count,
          colour: line.colour,
          stations,
          endId: last?.role === 'exit' ? last.id : undefined
        }
      ];
    });
    return { mapLines: lines, mapHubs: hubs };
    // statusWord, describe and t change together with the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, collapsed, t]);

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

  const unreachable = topologyQuery.isError && !topologyQuery.data;

  return (
    <PageFrame>
      <div className="space-y-8">
        <PageHeader title={t('title')} description={t('description')} />

        {loadError && !unreachable && (
          <div role="alert" className="flex flex-col gap-1 border-l-2 border-danger pl-3 text-body text-ink">
            <p className="font-medium">{t('staleWarning')}</p>
            <p className="text-caption text-ink-muted">{loadError}</p>
          </div>
        )}

        {topologyQuery.isPending ? (
          <Skeleton lines={5} />
        ) : unreachable ? (
          <ErrorState
            title={t('unreachable')}
            detail={topologyQuery.error?.message}
            onRetry={() => void topologyQuery.refetch()}
          />
        ) : (
          <section aria-label={t('map.title')} className="space-y-4">
            <p className="max-w-[65ch] text-body text-ink-muted">{t('map.description')}</p>

            <div className="relative rounded-plate border border-rule bg-sheet px-2 py-3">
              <div className="mb-1 flex justify-end sm:absolute sm:right-3 sm:top-3 sm:z-10 sm:mb-0">
                <Link
                  to={ROUTES.topology}
                  onClick={(event) => {
                    if (onNavigateTab) {
                      event.preventDefault();
                      onNavigateTab('topology');
                    }
                  }}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-control px-1.5 text-body font-medium text-ink underline underline-offset-4 hover:bg-surface-hover focus-visible:outline-focus"
                >
                  {t('openMap')}
                  <ArrowRight aria-hidden="true" size={16} />
                </Link>
              </div>
              {total === 0 ? (
                <div className="flex flex-col items-start gap-3 px-3 py-6">
                  <p className="max-w-[55ch] text-body text-ink-muted">{t('map.emptyHint')}</p>
                  <Button variant="primary" icon={Plus} onClick={shell.openEnroll}>
                    {t('addDevice')}
                  </Button>
                </div>
              ) : (
                <TransitMap
                  lines={mapLines}
                  hubs={mapHubs}
                  onOpenStation={openStation}
                  flow={flow}
                  label={t('map.title')}
                />
              )}
            </div>

            {total === 1 && (
              <div className="flex flex-wrap items-center gap-4">
                <Button variant="primary" icon={Plus} onClick={shell.openEnroll}>
                  {t('addDevice')}
                </Button>
              </div>
            )}

            <p role="status" className="text-lead text-ink">
              {sentence(model.tally)}
            </p>
            {collapsed && <p className="text-caption text-ink-muted">{t('map.collapsedNote')}</p>}
            {flowing && <p className="text-caption text-ink-muted">{t('map.flowLegend')}</p>}

            <ul aria-label={t('map.legend')} className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-ink-muted">
              {STATUS_ORDER.map((status) => (
                <li key={status} className="inline-flex items-center gap-1.5">
                  <StationSymbol kind={status} size={14} className={mapTone(status) ?? 'text-ink'} />
                  {statusWord(status)}
                </li>
              ))}
              <li className="inline-flex items-center gap-1.5">
                <StationSymbol kind="interchange" size={14} className="text-ink" />
                {t('map.gateway')}
              </li>
              <li className="inline-flex items-center gap-1.5">
                <StationSymbol kind="terminus" size={14} className="text-ink" />
                {t('map.exit')}
              </li>
            </ul>

            {total > 0 && (
              <details className="text-body text-ink">
                <summary className="inline-flex min-h-8 cursor-pointer items-center rounded-control text-ink underline focus-visible:outline-focus">
                  {t('map.listToggle')}
                </summary>
                <div className="mt-3 grid gap-6 sm:grid-cols-2">
                  {model.lines.map((line) => (
                    <section key={line.key} aria-label={line.label}>
                      <h3 className="text-body font-semibold text-ink">
                        {line.label}{' '}
                        <span className="font-normal text-ink-muted">
                          {t('map.deviceCount', { count: line.stations.length })}
                        </span>
                      </h3>
                      <ul className="mt-1 divide-y divide-border-subtle">
                        {line.stations.map((station) => (
                          <li key={station.id}>
                            <button
                              type="button"
                              onClick={() => openStation(station.id)}
                              className="flex min-h-9 w-full items-center justify-between gap-3 rounded-control px-1 text-left hover:bg-surface-hover focus-visible:outline-focus"
                            >
                              <span className="truncate text-ink">{station.name}</span>
                              <StationStatus kind={station.status} className="text-caption">
                                {statusWord(station.status)}
                              </StationStatus>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        {!unreachable && !topologyQuery.isPending && total > 0 && (
          <section aria-labelledby="overview-traffic-title" className="border-t border-rule pt-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 id="overview-traffic-title" className="text-title font-semibold text-ink">
                  {t('timeseriesTitle')}
                </h2>
                <p className="mt-1 max-w-[65ch] text-caption text-ink-muted">{t('timeseriesDesc')}</p>
              </div>
              <div role="group" aria-label={t('timeseriesTitle')} className="flex items-center gap-1">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setTimeRange(r)}
                    aria-pressed={timeRange === r}
                    className={`rounded-control px-2.5 py-1 text-caption tabular-nums focus-visible:outline-focus ${
                      timeRange === r ? 'bg-surface-hover font-medium text-ink' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div
              data-testid="native-traffic-coverage"
              className="mt-3 flex flex-col gap-0.5 text-caption text-ink-muted"
            >
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

            <p className="mt-4 flex flex-wrap items-baseline justify-between gap-2 text-caption text-ink-muted">
              <span>{t('lifetimeTransfer')}</span>
              <strong className="font-medium tabular-nums text-ink" title={stats?.total_bandwidth_bytes ?? undefined}>
                {stats?.total_bandwidth_bytes === null || stats?.total_bandwidth_bytes === undefined ? (
                  <NotMeasured />
                ) : (
                  formatBytes(stats.total_bandwidth_bytes)
                )}
              </strong>
            </p>
          </section>
        )}
      </div>
    </PageFrame>
  );
}
