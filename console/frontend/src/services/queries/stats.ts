import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type { GeoMatrixEntry, StatsOverview, TimeseriesPoint } from '../types';
import { queryKeys } from './keys';

/**
 * The fleet-wide counters behind the header ticker and the overview.
 *
 * The throughput fields are null until the collector has two samples to derive
 * a rate from, and stay null on a deployment where nothing samples them. The
 * caller draws "not measured", never a zero.
 */
export function useStatsOverview(): UseQueryResult<StatsOverview, Error> {
  return useQuery({
    queryKey: queryKeys.statsOverview,
    queryFn: ({ signal }) => apiRequest<StatsOverview>('/stats/overview', { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

/**
 * Network throughput rate timeseries aggregated across all sovereign nodes.
 * Samples are recorded once a minute. Two samples are required before a rate
 * point can be rendered.
 */
export function useStatsTimeseries(range: string = '24h'): UseQueryResult<TimeseriesPoint[], Error> {
  return useQuery({
    queryKey: queryKeys.statsTimeseries(range),
    queryFn: ({ signal }) =>
      apiRequest<TimeseriesPoint[]>(`/stats/timeseries?range=${encodeURIComponent(range)}`, { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}

/**
 * Geographic presence and latency metrics grouped by country code.
 */
export function useStatsGeoMatrix(): UseQueryResult<GeoMatrixEntry[], Error> {
  return useQuery({
    queryKey: queryKeys.statsGeoMatrix,
    queryFn: ({ signal }) => apiRequest<GeoMatrixEntry[]>('/stats/geo-matrix', { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000
  });
}
