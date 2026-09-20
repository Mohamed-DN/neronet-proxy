import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from '../apiClient';
import type { StatsOverview } from '../types';
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
