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
  acl: ['acl'] as const,
  aclRules: ['acl', 'rules'] as const,
  aclDefaultPolicy: ['acl', 'default-policy'] as const,
  aclCompiled: (nodeId: string) => ['acl', 'compiled', nodeId] as const,
  compartments: ['compartments'] as const,
  compartment: (id: string) => ['compartments', id] as const,
  auditEvents: (limit?: number) => ['audit', 'events', limit ?? 100] as const,
  auditVerify: ['audit', 'verify'] as const,
  auditCheckpoints: ['audit', 'checkpoints'] as const,
  auditSiem: ['audit', 'siem'] as const,
  nukeStatus: ['nuke', 'status'] as const,
  nukeLegalHolds: ['nuke', 'legal-holds'] as const,
  nukeDualAuth: ['nuke', 'dual-auth'] as const,
  nukeOwnerDms: ['nuke', 'owner-dms'] as const
};
