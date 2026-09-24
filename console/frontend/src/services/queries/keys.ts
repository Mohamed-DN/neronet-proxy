/**
 * Every cache key in one place, so that an invalidation from the live channel
 * and the hook that filled the cache cannot drift apart.
 */
export const queryKeys = {
  features: ['features'] as const,
  nodes: ['nodes'] as const,
  node: (id: string) => ['nodes', id] as const,
  statsOverview: ['stats', 'overview'] as const,
  statsTimeseries: (range: string) => ['stats', 'timeseries', range] as const,
  statsTopology: ['stats', 'topology'] as const,
  statsGeoMatrix: ['stats', 'geo-matrix'] as const,
  riskSummary: ['risk', 'summary'] as const,
  peering: ['peering'] as const,
  acl: ['acl'] as const
};
